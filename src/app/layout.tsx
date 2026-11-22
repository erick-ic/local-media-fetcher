import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "Local Media Fetcher · 本地媒体下载台",
  description:
    "基于 yt-dlp 与 ffmpeg 的本地多平台视频 / 音频下载控制台，文件直接保存至 ~/Downloads",
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-64.png", type: "image/png", sizes: "64x64" },
    ],
    apple: [{ url: "/apple-icon.png", sizes: "180x180" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} min-h-screen bg-[#f5f5f7] font-sans text-zinc-900 antialiased`}
      >
        <script
          // 在首屏渲染前恢复主题，避免颜色闪烁
          dangerouslySetInnerHTML={{
            __html:
              '(function(){try{var t=localStorage.getItem("lmf-theme");if(t&&["blue","apple","meta","telegram","youtube","netflix","instagram","spotify","whatsapp","discord","twitch","linkedin","reddit","x"].indexOf(t)>-1){document.documentElement.dataset.theme=t}}catch(e){}})();',
          }}
        />
        {children}
      </body>
    </html>
  );
}
