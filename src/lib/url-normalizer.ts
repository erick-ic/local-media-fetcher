import { lookup } from "node:dns/promises";
import net from "node:net";
import {
  isShortLinkHost,
  matchPlatformByUrl,
  type PlatformRule,
} from "@/lib/platforms";

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

const MAX_REDIRECTS = 6;

export interface NormalizedMediaUrl {
  originalUrl: string;
  normalizedUrl: string;
  expanded: boolean;
  platform: PlatformRule | null;
}

function isPrivateIp(address: string): boolean {
  if (net.isIPv4(address)) {
    const parts = address.split(".").map(Number);
    if (parts.length !== 4) return true;
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    return (
      lower === "::1" ||
      lower === "::" ||
      lower.startsWith("fe80:") ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("::ffff:127.") ||
      lower.startsWith("::ffff:10.") ||
      lower.startsWith("::ffff:192.168.")
    );
  }
  return true;
}

/** 防止短链追踪跳转到内网或本机地址（SSRF 防护） */
export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("仅支持 http/https 链接");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".local")) {
    throw new Error("不允许访问本地主机地址");
  }
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error("不允许访问内网 IP 地址");
    }
    return parsed;
  }

  try {
    const records = await lookup(hostname, { all: true });
    if (records.some((record) => isPrivateIp(record.address))) {
      throw new Error("链接指向内网地址，已拒绝访问");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("内网")) {
      throw error;
    }
    // DNS 暂时不可用时交由后续真实请求处理（例如仅代理环境可解析的域名）
  }

  return parsed;
}

/** 仅在明确短链或需要展开的分享链接上执行 302 追踪 */
async function followRedirects(startUrl: string): Promise<string> {
  let current = startUrl;

  for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
    await assertPublicHttpUrl(current);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let response: Response;
    try {
      response = await fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": MOBILE_UA,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
      });
    } finally {
      clearTimeout(timer);
    }

    // 避免占用响应体连接
    void response.body?.cancel().catch(() => {});

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) break;
      const nextUrl = new URL(location, current).toString();
      if (nextUrl === current) break;
      current = nextUrl;
      continue;
    }

    break;
  }

  return current;
}

/** 清理 B 站追踪参数，保留分 P（p）与时间点（t） */
function canonicalizeBilibili(parsed: URL): string {
  const keepKeys = new Set(["p", "t", "bvid", "aid"]);
  const next = new URL(parsed.origin + parsed.pathname);
  parsed.searchParams.forEach((value, key) => {
    if (keepKeys.has(key)) next.searchParams.set(key, value);
  });
  return next.toString();
}

/** 小红书规范化：保留 xsec_token / xsec_source，避免 404 或风控 */
function canonicalizeXiaohongshu(parsed: URL): string {
  const host = parsed.hostname.toLowerCase();
  if (!host.endsWith("xiaohongshu.com")) return parsed.toString();

  const noteMatch = parsed.pathname.match(
    /\/(?:explore|discovery\/item|user\/profile\/[^/]+)\/([0-9a-f]+)/i
  );
  if (!noteMatch) return parsed.toString();

  const next = new URL(`https://www.xiaohongshu.com/explore/${noteMatch[1]}`);
  const xsecToken = parsed.searchParams.get("xsec_token");
  const xsecSource = parsed.searchParams.get("xsec_source");
  if (xsecToken) next.searchParams.set("xsec_token", xsecToken);
  if (xsecSource) next.searchParams.set("xsec_source", xsecSource);
  return next.toString();
}

/**
 * 规范化外部视频链接：
 * 1. 自动展开国内短链（xhslink.com、b23.tv 等）
 * 2. 将平台变体链接规整为 yt-dlp 可稳定解析的标准 URL
 */
export async function normalizeMediaUrl(
  rawUrl: string
): Promise<NormalizedMediaUrl> {
  const trimmed = rawUrl.trim();
  let workingUrl = trimmed;
  let expanded = false;

  const initialPlatform = matchPlatformByUrl(trimmed);
  // 仅在服务端直连展开国内平台短链（国际短链如 youtu.be/t.co/vm.tiktok.com 由 yt-dlp 经代理原生解析，避免无代理超时）
  const shouldExpand =
    initialPlatform?.region === "cn" && isShortLinkHost(trimmed);

  if (shouldExpand) {
    try {
      const resolved = await followRedirects(trimmed);
      if (resolved && resolved !== trimmed) {
        workingUrl = resolved;
        expanded = true;
      }
    } catch {
      // 短链展开失败时不阻断主流程，交由后续解析器处理
    }
  }

  const platform = matchPlatformByUrl(workingUrl) ?? initialPlatform;

  try {
    const parsed = new URL(workingUrl);
    if (platform?.id === "bilibili") {
      workingUrl = canonicalizeBilibili(parsed);
    } else if (platform?.id === "xiaohongshu") {
      workingUrl = canonicalizeXiaohongshu(parsed);
    }
  } catch {
    // 保留原值
  }

  return {
    originalUrl: trimmed,
    normalizedUrl: workingUrl,
    expanded,
    platform,
  };
}
