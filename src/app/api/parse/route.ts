import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import {
  TOOL_ENV,
  authErrorHint,
  errorMessage,
  formatDuration,
  isHttpUrl,
  lastMeaningfulLine,
  normalizeCookieSource,
  cookieErrorHint,
} from "@/lib/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

const PLATFORM_LABELS: Record<string, string> = {
  Youtube: "YouTube",
  "Youtube Music": "YouTube Music",
  Twitter: "X / Twitter",
  TikTok: "TikTok",
  Instagram: "Instagram",
  Facebook: "Facebook",
};

interface YtDlpFormat {
  height?: number | null;
  ext?: string | null;
  vcodec?: string | null;
  acodec?: string | null;
  filesize?: number | null;
  filesize_approx?: number | null;
  tbr?: number | null;
}

interface ParsedPreset {
  key: string;
  label: string;
  height?: number | null;
  size: string | null;
  available: boolean;
}

interface YtDlpInfo {
  id?: string;
  title?: string;
  thumbnail?: string;
  thumbnails?: { url?: string }[];
  duration?: number;
  extractor?: string;
  extractor_key?: string;
  uploader?: string;
  webpage_url?: string;
  formats?: YtDlpFormat[];
}

/** 优先使用 yt-dlp 给出的体积，缺失时按码率 × 时长估算 */
function estimateBytes(
  format: YtDlpFormat | undefined,
  duration: number | null
): number | null {
  if (!format) return null;
  const direct = format.filesize ?? format.filesize_approx;
  if (typeof direct === "number" && direct > 0) return direct;
  if (duration && typeof format.tbr === "number" && format.tbr > 0) {
    return (format.tbr * 1000 * duration) / 8;
  }
  return null;
}

function formatBytes(bytes: number | null): string | null {
  if (!bytes || bytes <= 0) return null;
  const mb = bytes / 1024 / 1024;
  if (mb >= 1024) return `~${(mb / 1024).toFixed(2)} GB`;
  if (mb >= 100) return `~${Math.round(mb)} MB`;
  return `~${mb.toFixed(1)} MB`;
}

/** 根据实际可用格式生成画质档位，并估算每个档位的文件大小 */
function buildPresets(
  formats: YtDlpFormat[],
  duration: number | null
): ParsedPreset[] {
  const videoFormats = formats.filter(
    (format) =>
      typeof format.height === "number" &&
      format.height > 0 &&
      format.vcodec &&
      format.vcodec !== "none"
  );
  const audioFormats = formats.filter(
    (format) =>
      format.acodec &&
      format.acodec !== "none" &&
      (!format.vcodec || format.vcodec === "none")
  );

  const bestAudio = [...audioFormats].sort(
    (a, b) => (b.tbr ?? 0) - (a.tbr ?? 0)
  )[0];
  const audioBytes = estimateBytes(bestAudio, duration);

  // 取最高 6 档，避免不同平台格式过多导致选项爆炸
  const heights = Array.from(
    new Set(videoFormats.map((format) => format.height as number))
  )
    .sort((a, b) => b - a)
    .slice(0, 6);

  const presets: ParsedPreset[] = heights.map((height) => {
    const candidates = videoFormats.filter((format) => format.height === height);
    const chosen =
      candidates.find((format) => format.ext === "mp4") ??
      [...candidates].sort((a, b) => (b.tbr ?? 0) - (a.tbr ?? 0))[0];
    const hasAudio = Boolean(chosen?.acodec && chosen.acodec !== "none");
    const videoBytes = estimateBytes(chosen, duration);
    const totalBytes =
      videoBytes === null
        ? null
        : videoBytes + (hasAudio ? 0 : (audioBytes ?? 0));

    return {
      key: `${height}p`,
      label: `${height}p MP4`,
      height,
      size: formatBytes(totalBytes),
      available: true,
    };
  });

  // 音轨内容或其他无高度信息的源，回退到最佳画质
  if (presets.length === 0) {
    const fallback = [...videoFormats].sort(
      (a, b) => (b.tbr ?? 0) - (a.tbr ?? 0)
    )[0];
    presets.push({
      key: "best",
      label: "最佳画质 MP4",
      size: formatBytes(estimateBytes(fallback, duration)),
      available: true,
    });
  }

  presets.push({
    key: "mp3",
    label: "仅音频 MP3",
    size: formatBytes(audioBytes),
    available: true,
  });

  return presets;
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    url?: unknown;
    browserCookie?: unknown;
  } | null;

  const url = typeof body?.url === "string" ? body.url.trim() : "";
  if (!isHttpUrl(url)) {
    return NextResponse.json(
      { ok: false, message: "请提供合法的 http/https 视频链接" },
      { status: 400 }
    );
  }

  const cookie = normalizeCookieSource(body?.browserCookie);

  // 始终以数组形式传参，杜绝命令注入
  const args = ["--dump-single-json", "--no-warnings", "--no-playlist"];
  if (cookie) args.push("--cookies-from-browser", cookie);
  args.push(url);

  let stdout: string;
  try {
    const result = await execFileAsync("yt-dlp", args, {
      env: TOOL_ENV,
      timeout: 90_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      return NextResponse.json(
        {
          ok: false,
          message: "系统未检测到 yt-dlp，请先执行 brew install yt-dlp ffmpeg",
        },
        { status: 503 }
      );
    }
    const stderr =
      typeof (error as { stderr?: unknown }).stderr === "string"
        ? (error as { stderr: string }).stderr
        : "";
    const detail = lastMeaningfulLine(stderr).replace(/^ERROR:\s*/i, "");
    const friendly = cookieErrorHint(detail) || authErrorHint(detail, Boolean(cookie));
    return NextResponse.json(
      {
        ok: false,
        message:
          friendly ||
          detail ||
          errorMessage(error, "解析失败，请检查链接或 Cookie 设置"),
      },
      { status: 422 }
    );
  }

  let info: YtDlpInfo;
  try {
    info = JSON.parse(stdout) as YtDlpInfo;
  } catch {
    return NextResponse.json(
      { ok: false, message: "无法解析 yt-dlp 返回的元数据" },
      { status: 502 }
    );
  }

  const thumbnail =
    info.thumbnail ||
    (Array.isArray(info.thumbnails)
      ? [...info.thumbnails].reverse().find((item) => item?.url)?.url
      : undefined) ||
    null;

  const durationSeconds =
    typeof info.duration === "number" && info.duration > 0
      ? Math.round(info.duration)
      : null;

  const rawExtractor = info.extractor_key || info.extractor || "未知平台";

  return NextResponse.json({
    ok: true,
    media: {
      id: info.id ?? "",
      title: info.title?.trim() || "未命名媒体",
      thumbnail,
      duration: formatDuration(durationSeconds),
      durationSeconds,
      extractor: PLATFORM_LABELS[rawExtractor] ?? rawExtractor,
      uploader: info.uploader ?? null,
      webpageUrl: info.webpage_url || url,
      presets: buildPresets(info.formats ?? [], durationSeconds),
    },
  });
}
