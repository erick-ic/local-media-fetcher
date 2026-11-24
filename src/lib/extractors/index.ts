import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import {
  DOWNLOADS_DIR,
  TOOL_ENV,
  buildProxyArgs,
  errorMessage,
  formatDuration,
  lastMeaningfulLine,
  platformErrorHint,
} from "@/lib/media";
import {
  detectRegionByUrl,
  resolvePlatformLabel,
  type NetworkSettings,
  type PlatformRegion,
} from "@/lib/platforms";
import { normalizeMediaUrl } from "@/lib/url-normalizer";
import {
  formatBytes,
  type ParsedMedia,
  type ParsedPreset,
} from "@/lib/extractors/types";

const execFileAsync = promisify(execFile);

interface YtDlpFragment {
  duration?: number | null;
}

interface YtDlpFormat {
  url?: string | null;
  height?: number | null;
  ext?: string | null;
  vcodec?: string | null;
  acodec?: string | null;
  filesize?: number | null;
  filesize_approx?: number | null;
  tbr?: number | null;
  duration?: number | string | null;
  fragments?: YtDlpFragment[] | null;
  http_headers?: Record<string, string> | null;
}

interface YtDlpInfo {
  _type?: string;
  id?: string;
  title?: string;
  thumbnail?: string;
  thumbnails?: { url?: string }[];
  duration?: number | string | null;
  duration_string?: string | null;
  extractor?: string;
  extractor_key?: string;
  uploader?: string;
  webpage_url?: string;
  formats?: YtDlpFormat[];
  http_headers?: Record<string, string> | null;
  entries?: (YtDlpInfo | null)[] | null;
}

export function parsePositiveSeconds(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0
      ? Math.max(1, Math.round(value))
      : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 0) {
      return Math.max(1, Math.round(numeric));
    }
  }
  return null;
}

/** 解析 yt-dlp 的 duration_string（如 "0:45"、"1:23"、"1:02:03"） */
export function parseDurationString(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || !/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(trimmed)) {
    return null;
  }
  const parts = trimmed.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;

  let seconds = 0;
  for (const part of parts) {
    seconds = seconds * 60 + part;
  }
  return seconds > 0 ? Math.max(1, Math.round(seconds)) : null;
}

/** 从元数据、分片列表（HLS/DASH）中尽力提取视频时长 */
export function extractDurationFromMetadata(
  primary: YtDlpInfo,
  root: YtDlpInfo
): number | null {
  const direct =
    parsePositiveSeconds(primary.duration) ??
    parsePositiveSeconds(root.duration) ??
    parseDurationString(primary.duration_string) ??
    parseDurationString(root.duration_string);
  if (direct) return direct;

  const formats = primary.formats ?? root.formats ?? [];
  for (const format of formats) {
    const formatDuration = parsePositiveSeconds(format.duration);
    if (formatDuration) return formatDuration;

    if (Array.isArray(format.fragments) && format.fragments.length > 0) {
      const sum = format.fragments.reduce((acc, fragment) => {
        const d = fragment?.duration;
        return typeof d === "number" && Number.isFinite(d) && d > 0
          ? acc + d
          : acc;
      }, 0);
      if (sum > 0) return Math.max(1, Math.round(sum));
    }
  }

  return null;
}

function buildProbeEnv(
  region: PlatformRegion,
  network: NetworkSettings
): NodeJS.ProcessEnv {
  if (region !== "cn" || !network.cnDirect) return TOOL_ENV;
  const env: NodeJS.ProcessEnv = { ...TOOL_ENV };
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ]) {
    delete env[key];
  }
  return env;
}

/**
 * 当站点元数据未返回 duration（常见于小红书、部分 Instagram 帖子）时，
 * 用 ffprobe 轻量探测远端流头部时长（仅拉取极少字节，限时 4 秒，失败静默忽略）。
 */
async function probeRemoteDuration(
  primary: YtDlpInfo,
  region: PlatformRegion,
  network: NetworkSettings
): Promise<number | null> {
  const formats = primary.formats ?? [];
  const candidates = formats.filter(
    (format) => typeof format.url === "string" && /^https?:\/\//i.test(format.url)
  );
  if (candidates.length === 0) return null;

  const chosen =
    candidates.find((format) => format.ext === "mp4" || format.ext === "m4a") ??
    candidates[0];
  const streamUrl = chosen.url as string;

  const args = ["-v", "error"];
  const rawHeaders = chosen.http_headers ?? primary.http_headers;
  if (rawHeaders && typeof rawHeaders === "object") {
    const allowed = new Set(["user-agent", "referer", "cookie", "origin"]);
    const headerLines = Object.entries(rawHeaders)
      .filter(
        ([key, val]) =>
          allowed.has(key.toLowerCase()) &&
          typeof val === "string" &&
          val.trim() &&
          !/[\r\n]/.test(key) &&
          !/[\r\n]/.test(val)
      )
      .map(([key, val]) => `${key}: ${val}`);
    if (headerLines.length > 0) {
      args.push("-headers", `${headerLines.join("\r\n")}\r\n`);
    }
  }

  args.push(
    "-show_entries",
    "format=duration",
    "-of",
    "default=nw=1:nk=1",
    streamUrl
  );

  try {
    const { stdout } = await execFileAsync("ffprobe", args, {
      env: buildProbeEnv(region, network),
      timeout: 4000,
      maxBuffer: 1024 * 1024,
    });
    return parsePositiveSeconds(stdout.trim());
  } catch {
    return null;
  }
}

/** 最后兜底：若同时有文件体积与码率，按 filesize * 8 / (tbr * 1000) 估算 */
function estimateDurationFromFormats(formats: YtDlpFormat[]): number | null {
  for (const format of formats) {
    const size = format.filesize ?? format.filesize_approx;
    if (
      typeof size === "number" &&
      size > 0 &&
      typeof format.tbr === "number" &&
      format.tbr > 0
    ) {
      const seconds = (size * 8) / (format.tbr * 1000);
      if (Number.isFinite(seconds) && seconds >= 1 && seconds <= 86_400) {
        return Math.round(seconds);
      }
    }
  }
  return null;
}

export class ParseRouteError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
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

/**
 * 画质选择参数：
 * 同时优先 H.264 (avc1) 与 HEVC (hvc1/hev1)（macOS QuickTime 原生解码 HEVC，避免漏掉 B 站高清流）
 */
export function resolveFormatArgs(value: unknown): string[] | null {
  if (value === "mp3") {
    return ["-x", "--audio-format", "mp3", "--audio-quality", "0"];
  }
  if (value === "best") {
    return [
      "-f",
      "bestvideo[vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/bestvideo[vcodec^=hev1]+bestaudio/bestvideo[vcodec^=hvc1]+bestaudio/bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best",
      "--merge-output-format",
      "mp4",
    ];
  }

  if (typeof value === "string") {
    const match = value.match(/^(\d{3,4})p$/);
    if (match) {
      const height = Number(match[1]);
      if (height >= 144 && height <= 4320) {
        return [
          "-f",
          `bestvideo[height<=${height}][vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${height}][vcodec^=hev1]+bestaudio/bestvideo[height<=${height}][vcodec^=hvc1]+bestaudio/bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${height}]+bestaudio/best[height<=${height}][ext=mp4]/best`,
          "--merge-output-format",
          "mp4",
        ];
      }
    }
  }

  return null;
}

const DEFAULT_OUTPUT_TEMPLATE = path.join(
  DOWNLOADS_DIR,
  "%(title).80s_%(id)s.%(ext)s"
);

async function runYtDlpJson(args: string[]): Promise<string> {
  const result = await execFileAsync("yt-dlp", args, {
    env: TOOL_ENV,
    timeout: 90_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.stdout;
}

/** 统一解析入口：短链规范化 → yt-dlp 平台增强通道 */
export async function parseMediaLink(options: {
  url: string;
  cookie: "chrome" | "safari" | null;
  network: NetworkSettings;
}): Promise<ParsedMedia> {
  const { url, cookie, network } = options;
  const normalized = await normalizeMediaUrl(url);
  const { platform, normalizedUrl } = normalized;
  const region = platform?.region ?? detectRegionByUrl(normalizedUrl);

  // yt-dlp 增强通道（自动分流国内直连 / 国际代理 + 按需启用浏览器指纹伪装）
  const baseArgs = [
    "--dump-single-json",
    "--no-warnings",
    "--no-playlist",
    ...buildProxyArgs(region, network),
  ];
  if (cookie) baseArgs.push("--cookies-from-browser", cookie);

  const attemptArgs = platform?.impersonate
    ? [...baseArgs, "--impersonate", "chrome", normalizedUrl]
    : [...baseArgs, normalizedUrl];

  let stdout: string;
  try {
    stdout = await runYtDlpJson(attemptArgs);
  } catch (error) {
    const stderr =
      typeof (error as { stderr?: unknown }).stderr === "string"
        ? (error as { stderr: string }).stderr
        : "";

    // 若运行环境的 yt-dlp 不支持 impersonate，自动回退一次无指纹参数重试
    if (platform?.impersonate && /impersonate/i.test(stderr)) {
      try {
        stdout = await runYtDlpJson([...baseArgs, normalizedUrl]);
      } catch (retryError) {
        throw formatYtDlpParseError(retryError, platform?.id, Boolean(cookie));
      }
    } else {
      throw formatYtDlpParseError(error, platform?.id, Boolean(cookie));
    }
  }

  let info: YtDlpInfo;
  try {
    info = JSON.parse(stdout) as YtDlpInfo;
  } catch {
    throw new ParseRouteError("无法解析 yt-dlp 返回的元数据", 502);
  }

  // 多媒体合集 / 轮播帖（如 Instagram Carousel、B 站分 P）的真实时长与格式在 entries[0] 内
  const firstEntry = Array.isArray(info.entries)
    ? info.entries.find(
        (item): item is YtDlpInfo => Boolean(item && typeof item === "object")
      )
    : undefined;
  const primary: YtDlpInfo = firstEntry
    ? {
        ...info,
        ...firstEntry,
        title: firstEntry.title?.trim() || info.title,
        uploader: firstEntry.uploader ?? info.uploader,
        webpage_url: info.webpage_url || firstEntry.webpage_url,
      }
    : info;

  const thumbnail =
    primary.thumbnail ||
    (Array.isArray(primary.thumbnails)
      ? [...primary.thumbnails].reverse().find((item) => item?.url)?.url
      : undefined) ||
    info.thumbnail ||
    null;

  const formats = primary.formats ?? info.formats ?? [];
  const durationSeconds =
    extractDurationFromMetadata(primary, info) ??
    (await probeRemoteDuration(primary, region, network)) ??
    estimateDurationFromFormats(formats);

  const rawExtractor =
    primary.extractor_key ||
    primary.extractor ||
    info.extractor_key ||
    info.extractor;
  const extractor = resolvePlatformLabel(rawExtractor, normalizedUrl);

  const hint =
    !cookie && platform?.cookiePolicy === "recommended" && platform.cookieHint
      ? platform.cookieHint
      : null;

  return {
    id: primary.id ?? info.id ?? "",
    title: primary.title?.trim() || info.title?.trim() || "未命名媒体",
    thumbnail,
    duration: formatDuration(durationSeconds),
    durationSeconds,
    extractor,
    platformId: platform?.id ?? null,
    region,
    uploader: primary.uploader ?? info.uploader ?? null,
    webpageUrl: primary.webpage_url || info.webpage_url || normalizedUrl,
    normalizedUrl,
    presets: buildPresets(formats, durationSeconds),
    hint,
  };
}

function formatYtDlpParseError(
  error: unknown,
  platformId: string | undefined,
  cookieEnabled: boolean
): ParseRouteError {
  if ((error as { code?: unknown }).code === "ENOENT") {
    return new ParseRouteError(
      "系统未检测到 yt-dlp，请先执行 brew install yt-dlp ffmpeg",
      503
    );
  }
  const stderr =
    typeof (error as { stderr?: unknown }).stderr === "string"
      ? (error as { stderr: string }).stderr
      : "";
  const detail = lastMeaningfulLine(stderr).replace(/^ERROR:\s*/i, "");
  const friendly = platformErrorHint(detail, platformId, cookieEnabled);
  return new ParseRouteError(
    friendly || detail || errorMessage(error, "解析失败，请检查链接或 Cookie 设置"),
    422
  );
}

export interface PreparedDownloadCommand {
  args: string[];
  platformId: string | undefined;
}

/** 统一构建下载阶段 yt-dlp 参数 */
export async function prepareDownloadCommand(options: {
  url: string;
  formatType: string;
  formatArgs: string[];
  cookie: "chrome" | "safari" | null;
  network: NetworkSettings;
}): Promise<PreparedDownloadCommand> {
  const { url, formatArgs, cookie, network } = options;
  const normalized = await normalizeMediaUrl(url);
  const { platform, normalizedUrl } = normalized;
  const region = platform?.region ?? detectRegionByUrl(normalizedUrl);
  const proxyArgs = buildProxyArgs(region, network);

  const args = [
    "--newline",
    "--no-playlist",
    "--progress",
    ...proxyArgs,
    ...formatArgs,
  ];
  if (platform?.impersonate) {
    args.push("--impersonate", "chrome");
  }
  if (cookie) {
    args.push("--cookies-from-browser", cookie);
  }
  args.push("-o", DEFAULT_OUTPUT_TEMPLATE, normalizedUrl);

  return { args, platformId: platform?.id };
}
