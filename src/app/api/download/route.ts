import { execFile, spawn } from "node:child_process";
import type {
  ChildProcess,
  ChildProcessWithoutNullStreams,
} from "node:child_process";
import { rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import {
  DOWNLOADS_DIR,
  TOOL_ENV,
  authErrorHint,
  cookieErrorHint,
  isHttpUrl,
  lastMeaningfulLine,
  normalizeCookieSource,
} from "@/lib/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

const BEST_FORMAT_ARGS = [
  "-f",
  "bestvideo[vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
  "--merge-output-format",
  "mp4",
];

/** 解析动态画质标识：best / mp3 / 2160p / 1440p / 1080p … */
function resolveFormatArgs(value: unknown): string[] | null {
  if (value === "mp3") {
    return ["-x", "--audio-format", "mp3", "--audio-quality", "0"];
  }
  if (value === "best") return BEST_FORMAT_ARGS;

  if (typeof value === "string") {
    const match = value.match(/^(\d{3,4})p$/);
    if (match) {
      const height = Number(match[1]);
      if (height >= 144 && height <= 4320) {
        return [
          "-f",
          `bestvideo[height<=${height}][vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${height}][ext=mp4]/best`,
          "--merge-output-format",
          "mp4",
        ];
      }
    }
  }

  return null;
}

const OUTPUT_TEMPLATE = path.join(
  DOWNLOADS_DIR,
  "%(title).80s_%(id)s.%(ext)s"
);

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    url?: unknown;
    formatType?: unknown;
    browserCookie?: unknown;
  } | null;

  const url = typeof body?.url === "string" ? body.url.trim() : "";
  if (!isHttpUrl(url)) {
    return NextResponse.json(
      { ok: false, message: "请提供合法的 http/https 链接" },
      { status: 400 }
    );
  }

  const formatArgs = resolveFormatArgs(body?.formatType);
  if (!formatArgs) {
    return NextResponse.json(
      { ok: false, message: "不支持的画质选项" },
      { status: 400 }
    );
  }
  const cookie = normalizeCookieSource(body?.browserCookie);

  // 数组传参，避免任何 shell 字符串拼接
  const args = [
    "--newline",
    "--no-playlist",
    "--progress",
    ...formatArgs,
  ];
  if (cookie) args.push("--cookies-from-browser", cookie);
  args.push("-o", OUTPUT_TEMPLATE, url);

  const encoder = new TextEncoder();
  let child: ChildProcessWithoutNullStreams | null = null;
  let mediaChild: ChildProcess | null = null;
  let closed = false;

  // SSE 断开 / 前端取消时终止子进程，避免残留下载
  const stopChild = () => {
    closed = true;
    for (const proc of [child, mediaChild]) {
      if (proc && proc.exitCode === null && !proc.killed) {
        try {
          proc.kill("SIGTERM");
        } catch {
          // 进程可能已退出，忽略
        }
      }
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
          );
        } catch {
          closed = true;
        }
      };

      /**
       * macOS 的 QuickTime / 预览无法解码 MP4 容器中的 VP9 / AV1。
       * 下载完成后探测编码，必要时转码为 H.264，保证双击即可播放。
       */
      const ensureMacPlayable = async (input: string): Promise<string> => {
        if (closed) return input;

        let codec = "";
        try {
          const { stdout } = await execFileAsync(
            "ffprobe",
            [
              "-v",
              "error",
              "-select_streams",
              "v:0",
              "-show_entries",
              "stream=codec_name",
              "-of",
              "default=nw=1:nk=1",
              input,
            ],
            { env: TOOL_ENV, timeout: 15000 }
          );
          codec = stdout.trim();
        } catch {
          // 探测失败时保留原文件
          return input;
        }

        if (!codec || codec === "h264" || codec === "hevc") return input;
        if (closed) return input;

        send({ status: "merging" });

        const parsed = path.parse(input);
        const tempPath = path.join(parsed.dir, `${parsed.name}.compat.mp4`);

        const converted = await new Promise<boolean>((resolve) => {
          const ffmpegProcess = spawn(
            "ffmpeg",
            [
              "-y",
              "-v",
              "error",
              "-i",
              input,
              "-c:v",
              "libx264",
              "-preset",
              "veryfast",
              "-crf",
              "20",
              "-pix_fmt",
              "yuv420p",
              "-c:a",
              "aac",
              "-b:a",
              "192k",
              "-movflags",
              "+faststart",
              tempPath,
            ],
            { env: TOOL_ENV, stdio: "ignore" }
          );
          mediaChild = ffmpegProcess;
          ffmpegProcess.on("error", () => {
            mediaChild = null;
            resolve(false);
          });
          ffmpegProcess.on("close", (exitCode) => {
            mediaChild = null;
            resolve(exitCode === 0);
          });
        });

        if (!converted) {
          await rm(tempPath, { force: true }).catch(() => {});
          return input;
        }

        const outputPath =
          parsed.ext.toLowerCase() === ".mp4"
            ? input
            : path.join(parsed.dir, `${parsed.name}.mp4`);

        try {
          await unlink(input);
          await rename(tempPath, outputPath);
          return outputPath;
        } catch {
          await rm(tempPath, { force: true }).catch(() => {});
          return input;
        }
      };

      child = spawn("yt-dlp", args, { env: TOOL_ENV });
      child.stdin.end();

      let stdoutBuffer = "";
      let stderrBuffer = "";
      let mergedPath = "";
      let audioPath = "";
      let lastDestination = "";

      const handleLine = (rawLine: string) => {
        const line = rawLine.trim();
        if (!line) return;

        // [download]  45.3% of  10.00MiB at  3.21MiB/s ETA 00:07
        const progressMatch = line.match(/\[download\]\s+([\d.]+)%/);
        if (progressMatch) {
          const speedMatch = line.match(/at\s+([\d.]+\s*[KMGTP]?i?B\/s)/i);
          const etaMatch = line.match(/ETA\s+(\d+(?::\d+){1,2})/);
          send({
            status: "downloading",
            progress: Math.min(100, Number.parseFloat(progressMatch[1])),
            speed: speedMatch ? speedMatch[1].replace(/\s+/g, "") : "",
            eta: etaMatch ? etaMatch[1] : "",
          });
          return;
        }

        if (line.includes("[Merger]") || line.includes("Merging formats into")) {
          const mergeMatch = line.match(/Merging formats into "(.+)"/);
          if (mergeMatch) mergedPath = mergeMatch[1];
          send({ status: "merging" });
          return;
        }

        if (line.includes("[ExtractAudio]")) {
          send({ status: "merging" });
          const audioMatch = line.match(/Destination:\s+(.+)$/);
          if (audioMatch) audioPath = audioMatch[1].trim();
          return;
        }

        const destinationMatch = line.match(/\[download\] Destination:\s+(.+)$/);
        if (destinationMatch) {
          lastDestination = destinationMatch[1].trim();
          return;
        }

        const alreadyMatch = line.match(/\[download\]\s+(.+?)\s+has already been downloaded/);
        if (alreadyMatch) lastDestination = alreadyMatch[1].trim();
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        lines.forEach(handleLine);
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderrBuffer = (stderrBuffer + chunk).slice(-4000);
      });

      child.on("error", (error: NodeJS.ErrnoException) => {
        request.signal.removeEventListener("abort", stopChild);
        if (closed) return;
        send({
          status: "error",
          message:
            error.code === "ENOENT"
              ? "未找到 yt-dlp，请先执行 brew install yt-dlp ffmpeg"
              : error.message,
        });
        closed = true;
        try {
          controller.close();
        } catch {
          // 已关闭
        }
      });

      child.on("close", (code) => {
        request.signal.removeEventListener("abort", stopChild);
        if (closed) return;

        if (stdoutBuffer.trim()) {
          handleLine(stdoutBuffer);
          stdoutBuffer = "";
        }

        const complete = (filePath?: string) => {
          if (closed) return;
          send({ status: "done", filePath });
          closed = true;
          try {
            controller.close();
          } catch {
            // 已关闭
          }
        };

        if (code === 0) {
          const finalPath =
            mergedPath || audioPath || lastDestination || undefined;

          if (!finalPath || body?.formatType === "mp3") {
            complete(finalPath);
            return;
          }

          // 下载完成后确保 macOS 原生播放器可直接打开
          void ensureMacPlayable(finalPath)
            .then((output) => complete(output))
            .catch(() => complete(finalPath));
          return;
        }

        const detail = lastMeaningfulLine(stderrBuffer).replace(
          /^ERROR:\s*/i,
          ""
        );
        send({
          status: "error",
          message:
            cookieErrorHint(detail) ||
            authErrorHint(detail, Boolean(cookie)) ||
            detail ||
            `yt-dlp 退出码 ${code ?? "未知"}`,
        });

        closed = true;
        try {
          controller.close();
        } catch {
          // 已关闭
        }
      });

      request.signal.addEventListener("abort", stopChild);
    },
    cancel() {
      stopChild();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
