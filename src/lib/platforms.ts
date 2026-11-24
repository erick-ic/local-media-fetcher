export type PlatformRegion = "global" | "cn";
export type CookiePolicy = "none" | "recommended" | "required";

export interface PlatformRule {
  id: string;
  label: string;
  extractorLabel?: string;
  mark: string;
  tileBg: string;
  homeUrl: string;
  region: PlatformRegion;
  cookiePolicy: CookiePolicy;
  cookieHint?: string;
  impersonate?: boolean;
  domains: string[];
  shortDomains?: string[];
  extractorKeys?: string[];
}

/** 统一平台注册表：前端展示、短链展开、代理分流、解析路由与报错指引均由此驱动 */
export const PLATFORM_RULES: PlatformRule[] = [
  // 国际平台
  {
    id: "youtube",
    label: "YouTube",
    mark: "▶",
    tileBg: "#ff0033",
    homeUrl: "https://www.youtube.com",
    region: "global",
    cookiePolicy: "none",
    domains: ["youtube.com", "youtu.be", "music.youtube.com"],
    shortDomains: ["youtu.be"],
    extractorKeys: ["Youtube", "YoutubeTab", "Youtube Music"],
  },
  {
    id: "tiktok",
    label: "TikTok",
    mark: "♪",
    tileBg: "#18181b",
    homeUrl: "https://www.tiktok.com",
    region: "global",
    cookiePolicy: "none",
    domains: ["tiktok.com"],
    shortDomains: ["vm.tiktok.com", "vt.tiktok.com"],
    extractorKeys: ["TikTok", "TikTokVM"],
  },
  {
    id: "x",
    label: "X",
    extractorLabel: "X / Twitter",
    mark: "X",
    tileBg: "#18181b",
    homeUrl: "https://x.com",
    region: "global",
    cookiePolicy: "none",
    domains: ["x.com", "twitter.com"],
    shortDomains: ["t.co"],
    extractorKeys: ["Twitter"],
  },
  {
    id: "facebook",
    label: "Facebook",
    mark: "f",
    tileBg: "#1877f2",
    homeUrl: "https://www.facebook.com",
    region: "global",
    cookiePolicy: "none",
    domains: ["facebook.com", "fb.watch"],
    shortDomains: ["fb.watch"],
    extractorKeys: ["Facebook", "FacebookReel"],
  },
  {
    id: "instagram",
    label: "Instagram",
    mark: "◎",
    tileBg: "linear-gradient(135deg, #f9ce34 0%, #ee2a7b 50%, #6228d7 100%)",
    homeUrl: "https://www.instagram.com",
    region: "global",
    cookiePolicy: "required",
    cookieHint: "Instagram 多数内容需要开启浏览器 Cookie 接力",
    domains: ["instagram.com", "instagr.am"],
    extractorKeys: ["Instagram", "InstagramStory", "InstagramReel"],
  },

  // 国内平台（默认直连，避免海外代理导致风控或限速）
  {
    id: "bilibili",
    label: "Bilibili",
    mark: "B",
    tileBg: "#fb7299",
    homeUrl: "https://www.bilibili.com",
    region: "cn",
    cookiePolicy: "recommended",
    cookieHint: "未登录最高 480p，开启浏览器 Cookie 可解锁 1080p / 4K",
    domains: ["bilibili.com", "b23.tv", "bili2233.cn"],
    shortDomains: ["b23.tv", "bili2233.cn"],
    extractorKeys: [
      "BiliBili",
      "BiliBiliBangumi",
      "BiliBiliBangumiMedia",
      "BiliBiliDynamic",
    ],
  },
  {
    id: "xiaohongshu",
    label: "小红书",
    mark: "红",
    tileBg: "#ff2442",
    homeUrl: "https://www.xiaohongshu.com",
    region: "cn",
    cookiePolicy: "recommended",
    cookieHint: "建议从 App 复制完整分享链接，必要时开启浏览器 Cookie",
    impersonate: true,
    domains: ["xiaohongshu.com", "xhslink.com"],
    shortDomains: ["xhslink.com"],
    extractorKeys: ["XiaoHongShu"],
  },
];

/** 常见其他国内域名：即使未出现在首页徽章中，也自动识别为国内直连 */
const EXTRA_CN_DOMAINS = [
  "kuaishou.com",
  "chenzhongtech.com",
  "zhihu.com",
  "acfun.cn",
  "cctv.com",
  "douyu.com",
  "huya.com",
  "qq.com",
  "iqiyi.com",
  "youku.com",
  "mgtv.com",
  "sohu.com",
  "baidu.com",
  "pearvideo.com",
  "163.com",
];

function hostnameMatches(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase();
  const target = domain.toLowerCase();
  return host === target || host.endsWith(`.${target}`);
}

export function matchPlatformByUrl(rawUrl: string): PlatformRule | null {
  try {
    const { hostname } = new URL(rawUrl);
    for (const rule of PLATFORM_RULES) {
      if (
        rule.domains.some((domain) => hostnameMatches(hostname, domain)) ||
        rule.shortDomains?.some((domain) => hostnameMatches(hostname, domain))
      ) {
        return rule;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function isShortLinkHost(rawUrl: string): boolean {
  try {
    const { hostname } = new URL(rawUrl);
    return PLATFORM_RULES.some((rule) =>
      rule.shortDomains?.some((domain) => hostnameMatches(hostname, domain))
    );
  } catch {
    return false;
  }
}

export function detectRegionByUrl(rawUrl: string): PlatformRegion {
  const matched = matchPlatformByUrl(rawUrl);
  if (matched) return matched.region;

  try {
    const { hostname } = new URL(rawUrl);
    if (
      hostname.toLowerCase().endsWith(".cn") ||
      EXTRA_CN_DOMAINS.some((domain) => hostnameMatches(hostname, domain))
    ) {
      return "cn";
    }
  } catch {
    // 非法 URL 回退默认策略
  }

  return "global";
}

export function resolvePlatformLabel(
  extractorKey: string | undefined,
  fallbackUrl?: string
): string {
  if (extractorKey) {
    const matched = PLATFORM_RULES.find((rule) =>
      rule.extractorKeys?.some(
        (key) => key.toLowerCase() === extractorKey.toLowerCase()
      )
    );
    if (matched) return matched.extractorLabel ?? matched.label;
  }

  if (fallbackUrl) {
    const byUrl = matchPlatformByUrl(fallbackUrl);
    if (byUrl) return byUrl.extractorLabel ?? byUrl.label;
  }

  return extractorKey || "未知平台";
}

export interface NetworkSettings {
  cnDirect: boolean;
}

export const DEFAULT_NETWORK_SETTINGS: NetworkSettings = {
  cnDirect: true,
};

export const NETWORK_STORAGE_KEY = "lmf-network";

/**
 * 从分享文案中提取首个 http(s) 链接。
 * 仅匹配合法 ASCII URL 字符，防止国内 App 分享口令中紧贴链接的汉字/书名号/Emoji 被吞入 URL。
 */
export function extractUrlFromText(text: string): string | null {
  const match = text.match(/https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/i);
  if (!match) return null;
  return match[0].replace(/[),.;\]}]+$/, "");
}

