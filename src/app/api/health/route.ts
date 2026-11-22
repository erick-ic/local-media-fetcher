import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { DOWNLOADS_DIR, TOOL_ENV } from "@/lib/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

async function readVersion(
  command: string,
  args: string[]
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: 8000,
      env: TOOL_ENV,
    });
    const firstLine = stdout.trim().split("\n")[0]?.trim();
    return firstLine || null;
  } catch {
    return null;
  }
}

export async function GET() {
  const [ytdlpVersion, ffmpegVersion] = await Promise.all([
    readVersion("yt-dlp", ["--version"]),
    readVersion("ffmpeg", ["-version"]),
  ]);

  const ytdlp = Boolean(ytdlpVersion);
  const ffmpeg = Boolean(ffmpegVersion);

  return NextResponse.json(
    {
      ok: ytdlp && ffmpeg,
      ytdlp,
      ffmpeg,
      ytdlpVersion,
      ffmpegVersion,
      downloadsDir: DOWNLOADS_DIR,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
