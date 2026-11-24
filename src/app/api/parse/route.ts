import { NextResponse } from "next/server";
import {
  errorMessage,
  isHttpUrl,
  normalizeCookieSource,
  normalizeNetworkSettings,
} from "@/lib/media";
import { parseMediaLink, ParseRouteError } from "@/lib/extractors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    url?: unknown;
    browserCookie?: unknown;
    network?: unknown;
  } | null;

  const url = typeof body?.url === "string" ? body.url.trim() : "";
  if (!isHttpUrl(url)) {
    return NextResponse.json(
      { ok: false, message: "请提供合法的 http/https 视频链接" },
      { status: 400 }
    );
  }

  const cookie = normalizeCookieSource(body?.browserCookie);
  const network = normalizeNetworkSettings(body?.network);

  try {
    const media = await parseMediaLink({ url, cookie, network });
    return NextResponse.json({ ok: true, media });
  } catch (error) {
    if (error instanceof ParseRouteError) {
      return NextResponse.json(
        { ok: false, message: error.message },
        { status: error.status }
      );
    }
    return NextResponse.json(
      { ok: false, message: errorMessage(error, "解析失败，请稍后重试") },
      { status: 422 }
    );
  }
}
