import type { PlatformRegion } from "@/lib/platforms";

export interface ParsedPreset {
  key: string;
  label: string;
  height?: number | null;
  size: string | null;
  available: boolean;
}

export interface ParsedMedia {
  id: string;
  title: string;
  thumbnail: string | null;
  duration: string;
  durationSeconds: number | null;
  extractor: string;
  platformId: string | null;
  region: PlatformRegion;
  uploader: string | null;
  webpageUrl: string;
  normalizedUrl: string;
  presets: ParsedPreset[];
  hint?: string | null;
}

export function formatBytes(bytes: number | null): string | null {
  if (!bytes || bytes <= 0) return null;
  const mb = bytes / 1024 / 1024;
  if (mb >= 1024) return `~${(mb / 1024).toFixed(2)} GB`;
  if (mb >= 100) return `~${Math.round(mb)} MB`;
  return `~${mb.toFixed(1)} MB`;
}
