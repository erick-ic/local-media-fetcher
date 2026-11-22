"use client";

import Link from "next/link";
import { ArrowLeft, Check, Palette } from "lucide-react";
import { useEffect, useState } from "react";
import {
  DEFAULT_THEME,
  isThemeId,
  THEMES,
  THEME_STORAGE_KEY,
  type ThemeId,
} from "@/lib/theme";

export default function SettingsPage() {
  const [theme, setTheme] = useState<ThemeId>(DEFAULT_THEME);

  useEffect(() => {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeId(saved)) setTheme(saved);
  }, []);

  const selectTheme = (id: ThemeId) => {
    setTheme(id);
    document.documentElement.dataset.theme = id;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, id);
    } catch {
      // 隐私模式下 localStorage 可能不可用，当前会话内仍然生效
    }
  };

  return (
    <main className="mx-auto w-full max-w-3xl px-5 pb-16 pt-6 sm:px-8">
      <header className="flex items-center justify-between">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200/80 bg-white px-3 py-1.5 text-[11.5px] font-medium text-zinc-500 transition-colors hover:border-zinc-300 hover:text-zinc-800"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          返回控制台
        </Link>
        <div className="flex items-center gap-1.5 text-[13px] font-semibold tracking-tight text-zinc-900">
          <Palette className="h-4 w-4 text-brand" />
          主题设置
        </div>
      </header>

      <section className="mt-6 rounded-[22px] border border-zinc-200/80 bg-white p-5 shadow-sm sm:p-6">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[15px] font-semibold tracking-tight text-zinc-900">
            主题色
          </h2>
          <span className="font-mono text-[9.5px] tracking-[0.08em] text-zinc-400">
            ACCENT COLOR
          </span>
        </div>
        <p className="mt-1 text-[12px] leading-5 text-zinc-500">
          用于按钮、进度条与选中态，选择后立即生效并保存在本机。
        </p>

        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {THEMES.map((item) => {
            const active = theme === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => selectTheme(item.id)}
                className={`flex items-center gap-2.5 rounded-2xl border px-3.5 py-3 text-left transition-all ${
                  active
                    ? "border-zinc-900/80 bg-zinc-50"
                    : "border-zinc-200 bg-white hover:border-zinc-300"
                }`}
              >
                <span
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
                  style={{ backgroundColor: item.brand }}
                >
                  {active && (
                    <Check className="h-3.5 w-3.5 text-white" strokeWidth={3} />
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block text-[12px] font-medium text-zinc-800">
                    {item.label}
                  </span>
                  <span className="block font-mono text-[9.5px] uppercase text-zinc-400">
                    {item.brand}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="mt-4 rounded-[22px] border border-zinc-200/80 bg-white p-5 shadow-sm sm:p-6">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[15px] font-semibold tracking-tight text-zinc-900">
            预览
          </h2>
          <span className="font-mono text-[9.5px] tracking-[0.08em] text-zinc-400">
            PREVIEW
          </span>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span className="inline-flex h-9 items-center justify-center rounded-full bg-brand px-4 text-[12px] font-semibold text-white shadow-sm">
            立即下载
          </span>
          <span className="rounded-xl border border-brand bg-brand/[0.06] px-3 py-2 text-[11px] font-medium text-brand-strong">
            1080p MP4
          </span>
          <div className="min-w-[150px] flex-1">
            <div className="flex items-center justify-between font-mono text-[9.5px] text-zinc-400">
              <span>下载中</span>
              <span>64%</span>
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-zinc-100">
              <div className="h-full w-[64%] rounded-full bg-brand" />
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
