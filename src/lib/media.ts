import os from "node:os";
import path from "node:path";

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

/** 识别浏览器 Cookie 读取失败，给出 macOS 权限指引 */
export function cookieErrorHint(detail: string): string | null {
  if (
    /operation not permitted|cookies\.binarycookies|permission denied|operation not allowed/i.test(
      detail
    )
  ) {
    return "无法读取浏览器 Cookie：请在「系统设置 → 隐私与安全性 → 完全磁盘访问权限」中为运行开发服务的终端应用（Trae / Terminal / iTerm）开启权限，然后重启应用与 npm run dev 再试。";
  }

  if (/could not find .*cookies database|no such file|cookies database.*not found/i.test(detail)) {
    return "未找到所选浏览器的 Cookie 数据库：请确认该浏览器已安装并登录过目标平台。";
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
