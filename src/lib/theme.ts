export const THEMES = [
  { id: "blue", label: "靛蓝", brand: "#2563eb", strong: "#1d4ed8" },
  { id: "apple", label: "Apple", brand: "#0071e3", strong: "#005bb8" },
  { id: "meta", label: "Meta", brand: "#0866ff", strong: "#0757d9" },
  { id: "telegram", label: "Telegram", brand: "#0077a8", strong: "#005e86" },
  { id: "youtube", label: "YouTube", brand: "#d90000", strong: "#b80000" },
  { id: "netflix", label: "Netflix", brand: "#e50914", strong: "#c40812" },
  { id: "instagram", label: "Instagram", brand: "#d81b60", strong: "#b0154f" },
  { id: "spotify", label: "Spotify", brand: "#0e7a35", strong: "#0a5c28" },
  { id: "whatsapp", label: "WhatsApp", brand: "#0b6b60", strong: "#07534a" },
  { id: "discord", label: "Discord", brand: "#4752c4", strong: "#3c45a5" },
  { id: "twitch", label: "Twitch", brand: "#7b2ff2", strong: "#6420c9" },
  { id: "linkedin", label: "LinkedIn", brand: "#0a66c2", strong: "#084e96" },
  { id: "reddit", label: "Reddit", brand: "#d93a00", strong: "#b32f00" },
  { id: "x", label: "X", brand: "#0f1419", strong: "#000000" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

export const DEFAULT_THEME: ThemeId = "blue";
export const THEME_STORAGE_KEY = "lmf-theme";

export function isThemeId(value: string | null): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}
