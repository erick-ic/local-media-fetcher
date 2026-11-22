import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import {
  DOWNLOADS_DIR,
  TOOL_ENV,
  errorMessage,
  isInsideDownloads,
} from "@/lib/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    filePath?: unknown;
  } | null;

  const rawPath = typeof body?.filePath === "string" ? body.filePath.trim() : "";

  if (rawPath && !isInsideDownloads(rawPath)) {
    return NextResponse.json(
      { ok: false, message: "仅允许打开 ~/Downloads 目录内的文件" },
      { status: 400 }
    );
  }

  if (rawPath) {
    let exists = false;
    try {
      exists = statSync(rawPath).isFile();
    } catch {
      exists = false;
    }
    if (!exists) {
      return NextResponse.json(
        { ok: false, missing: true, message: "文件已被删除或移动" },
        { status: 404 }
      );
    }
  }

  try {
    if (rawPath) {
      // open -R 在 Finder 中高亮定位具体文件
      await execFileAsync("open", ["-R", rawPath], { env: TOOL_ENV });
    } else {
      await execFileAsync("open", [DOWNLOADS_DIR], { env: TOOL_ENV });
    }
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: errorMessage(error, "打开 Finder 失败") },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
