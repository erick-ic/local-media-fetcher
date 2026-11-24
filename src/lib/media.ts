import os from "node:os";
import path from "node:path";
import {
  DEFAULT_NETWORK_SETTINGS,
  type NetworkSettings,
  type PlatformRegion,
} from "@/lib/platforms";

/** 下载落盘目录：当前 macOS 用户的 ~/Downloads */
export const DOWNLOADS_DIR = path.join(os.homedir(), "Downloads");

/** 补齐 Homebrew 常见安装路径，避免启动环境缺少 PATH 时找不到 CLI */
export const TOOL_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin"]
    .filter(Boolean)
    .join(":"),
};

/** 仅允许受支持的浏览器 Cookie 接力来源 */
export function normalizeCookieSource(
  value: unknown
): "chrome" | "safari" | null {
  return value === "chrome" || value === "safari" ? value : null;
}

/** 严格校验 http/https 链接，避免把任意字符串交给子进程 */
export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** 判断路径是否位于 ~/Downloads 内，防止越权打开任意目录 */
export function isInsideDownloads(target: string): boolean {
  const resolved = path.resolve(target);
  return (
    resolved === DOWNLOADS_DIR || resolved.startsWith(DOWNLOADS_DIR + path.sep)
  );
}

/** 秒数格式化为 0:00 / 0:00:00 */
export function formatDuration(totalSeconds?: number | null): string {
  if (!totalSeconds || totalSeconds <= 0) return "未知时长";
  const seconds = Math.round(totalSeconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(rest).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}

/** 从多行日志中取最后一条有效信息 */
export function lastMeaningfulLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .pop() ?? ""
  );
}

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message || fallback;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

/** 识别浏览器 Cookie 读取失败，给出 macOS 权限或路径指引并保留原始细节 */
export function cookieErrorHint(detail: string): string | null {
  if (
    /operation not permitted|cookies\.binarycookies|permission denied|operation not allowed/i.test(
      detail
    )
  ) {
    return `无法读取浏览器 Cookie（权限被拒）：请在「系统设置 → 隐私与安全性 → 完全磁盘访问权限」中为运行 npm run dev 的终端 / IDE 开启权限，完全退出（Cmd+Q）并重启后再试。（${detail}）`;
  }

  // macOS 上终端无完全磁盘访问权限时，Python os.path.isfile 会吞掉 EPERM 导致 yt-dlp 报找不到 Safari 数据库
  if (/could not find safari cookies database/i.test(detail)) {
    return `无法访问 Safari Cookie 数据库：这在 macOS 上通常是运行 npm run dev 的终端 / IDE 未开启「完全磁盘访问权限」导致的（系统会隐藏 Safari Cookie 文件）。请前往「系统设置 → 隐私与安全性 → 完全磁盘访问权限」勾选对应终端 / IDE，完全退出（Cmd+Q）并重启服务后再试。`;
  }

  if (/could not find .*cookies database|cookies database.*not found/i.test(detail)) {
    return `未找到所选浏览器的 Cookie 数据库：若你实际使用的是 Edge / Brave / Arc / Firefox / Chrome 测试版，或登录在其他浏览器中，选当前选项会读不到对应目录。（${detail}）`;
  }

  return null;
}

/** 识别登录态 / 风控类错误，转换为可执行的中文提示 */
export function authErrorHint(
  detail: string,
  cookieEnabled: boolean
): string | null {
  const authPattern =
    /empty media response|login required|login needed|requires authentication|use --cookies|--cookies-from-browser|sign in to confirm|not logged in|private (?:video|account|post)|http error 401|http error 403/i;
  if (!authPattern.test(detail)) return null;

  if (cookieEnabled) {
    return "平台仍拒绝访问：请确认浏览器中已登录对应账号；若 Chrome 正在后台运行，请完全退出后重试。必要时执行 brew upgrade yt-dlp 更新解析器。";
  }

  return "该内容需要登录态：请在右上角「浏览器 Cookies」中选择 Chrome 或 Safari，并确保浏览器已登录该平台后重试（Safari 需为终端或 Trae 开启「完全磁盘访问权限」）。";
}

export function normalizeNetworkSettings(value: unknown): NetworkSettings {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_NETWORK_SETTINGS };
  }
  const raw = value as Record<string, unknown>;
  return {
    cnDirect:
      typeof raw.cnDirect === "boolean"
        ? raw.cnDirect
        : DEFAULT_NETWORK_SETTINGS.cnDirect,
  };
}

/** 按站点区域自动生成 yt-dlp 代理参数：国内默认强制直连，国际跟随系统代理 */
export function buildProxyArgs(
  region: PlatformRegion,
  network: NetworkSettings
): string[] {
  if (region === "cn" && network.cnDirect) {
    return ["--proxy", ""];
  }
  return [];
}

/** 针对国内平台常见风控/Cookie/参数错误给出精准可执行提示 */
export function platformErrorHint(
  detail: string,
  platformId: string | undefined,
  cookieEnabled: boolean
): string | null {
  const cookieHint = cookieErrorHint(detail);
  if (cookieHint) return cookieHint;

  if (platformId === "xiaohongshu") {
    if (/404|not found|xsec_token|unable to extract|login|forbidden/i.test(detail)) {
      return "小红书解析受限：请从 App 复制包含完整参数的最新分享链接（含 xhslink.com 或 xsec_token），并在右上角开启已登录小红书的浏览器 Cookie 后重试。";
    }
  }

  if (platformId === "bilibili") {
    if (/vip|大会员|region|地区|copyright|版权/i.test(detail)) {
      return "B 站该内容受大会员或地区版权限制：请确认已开启对应账号的浏览器 Cookie，并检查「设置」中已开启“国内平台强制直连”。";
    }
  }

  return authErrorHint(detail, cookieEnabled);
}

