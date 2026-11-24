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
  TOOL_ENV,
  errorMessage,
  isHttpUrl,
  lastMeaningfulLine,
  normalizeCookieSource,
  normalizeNetworkSettings,
  platformErrorHint,
} from "@/lib/media";
import { prepareDownloadCommand, resolveFormatArgs } from "@/lib/extractors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    url?: unknown;
    formatType?: unknown;
    browserCookie?: unknown;
    network?: unknown;
  } | null;

  const url = typeof body?.url === "string" ? body.url.trim() : "";
  if (!isHttpUrl(url)) {
    return NextResponse.json(
      { ok: false, message: "请提供合法的 http/https 链接" },
      { status: 400 }
    );
  }

  const formatType = typeof body?.formatType === "string" ? body.formatType : "";
  const formatArgs = resolveFormatArgs(formatType);
  if (!formatArgs) {
    return NextResponse.json(
      { ok: false, message: "不支持的画质选项" },
      { status: 400 }
    );
  }
  const cookie = normalizeCookieSource(body?.browserCookie);
  const network = normalizeNetworkSettings(body?.network);

  let prepared: { args: string[]; platformId: string | undefined };
  try {
    prepared = await prepareDownloadCommand({
      url,
      formatType,
      formatArgs,
      cookie,
      network,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: errorMessage(error, "准备下载参数失败") },
      { status: 422 }
    );
  }

  const { args, platformId } = prepared;
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

  const runFfmpeg = (ffmpegArgs: string[]): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const ffmpegProcess = spawn("ffmpeg", ffmpegArgs, {
        env: TOOL_ENV,
        stdio: "ignore",
      });
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
       * 确保下载完成的视频可被 macOS QuickTime / 访达预览直接打开：
       * - H.264 直接放行
       * - HEVC 若封装标签为 hev1（常见于 B 站），无损秒级重封装为 hvc1
       * - VP9 / AV1 等优先使用 Apple Silicon VideoToolbox 硬件加速转 H.264，失败回退 libx264
       */
      const ensureMacPlayable = async (input: string): Promise<string> => {
        if (closed) return input;

        let codec = "";
        let codecTag = "";
        try {
          const { stdout } = await execFileAsync(
            "ffprobe",
            [
              "-v",
              "error",
              "-select_streams",
              "v:0",
              "-show_entries",
              "stream=codec_name,codec_tag_string",
              "-of",
              "csv=p=0",
              input,
            ],
            { env: TOOL_ENV, timeout: 15000 }
          );
          const [name = "", tag = ""] = stdout.trim().split(",");
          codec = name.trim().toLowerCase();
          codecTag = tag.trim().toLowerCase();
        } catch {
          return input;
        }

        if (!codec || codec === "h264") return input;
        if (codec === "hevc" && codecTag === "hvc1") return input;
        if (closed) return input;

        send({ status: "merging" });

        const parsed = path.parse(input);
        const tempPath = path.join(parsed.dir, `${parsed.name}.compat.mp4`);

        let converted = false;
        if (codec === "hevc") {
          // 无损重封装 hev1 -> hvc1，耗时通常 <1 秒且零画质损失
          converted = await runFfmpeg([
            "-y",
            "-v",
            "error",
            "-i",
            input,
            "-c",
            "copy",
            "-tag:v",
            "hvc1",
            "-movflags",
            "+faststart",
            tempPath,
          ]);
        }

        if (!converted && !closed) {
          // 优先使用 macOS VideoToolbox 硬件编码加速
          converted = await runFfmpeg([
            "-y",
            "-v",
            "error",
            "-i",
            input,
            "-c:v",
            "h264_videotoolbox",
            "-q:v",
            "65",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            tempPath,
          ]);
        }

        if (!converted && !closed) {
          // 硬件编码不可用时自动回退 libx264 软编码
          converted = await runFfmpeg([
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
          ]);
        }

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

        const alreadyMatch = line.match(
          /\[download\]\s+(.+?)\s+has already been downloaded/
        );
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

          if (!finalPath || formatType === "mp3") {
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
            platformErrorHint(detail, platformId, Boolean(cookie)) ||
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
