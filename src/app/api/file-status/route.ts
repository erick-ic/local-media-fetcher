import { statSync } from "node:fs";
import { NextResponse } from "next/server";
import { isInsideDownloads } from "@/lib/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    paths?: unknown;
  } | null;

  const paths = Array.isArray(body?.paths)
    ? body.paths
        .filter(
          (item): item is string =>
            typeof item === "string" && isInsideDownloads(item)
        )
        .slice(0, 100)
    : [];

  const missing = paths.filter((filePath) => {
    try {
      return !statSync(filePath).isFile();
    } catch {
      return true;
    }
  });

  return NextResponse.json({ ok: true, missing });
}
