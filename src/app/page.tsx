"use client";

import Link from "next/link";
import {
  AlertTriangle,
  ArrowDownToLine,
  Check,
  ClipboardPaste,
  Copy,
  FolderOpen,
  Info,
  Link2,
  Loader2,
  Lock,
  RefreshCw,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import {
  DEFAULT_NETWORK_SETTINGS,
  extractUrlFromText,
  NETWORK_STORAGE_KEY,
  PLATFORM_RULES,
  type NetworkSettings,
  type PlatformRegion,
  type PlatformRule,
} from "@/lib/platforms";

type CookieSource = "none" | "chrome" | "safari";
type TaskStatus = "downloading" | "merging" | "done" | "error" | "canceled";

interface Preset {
  key: string;
  label: string;
  height?: number | null;
  size?: string | null;
  available: boolean;
}

interface MediaInfo {
  sourceUrl: string;
  normalizedUrl?: string;
  id: string;
  title: string;
  thumbnail: string | null;
  duration: string;
  durationSeconds: number | null;
  extractor: string;
  platformId?: string | null;
  region?: PlatformRegion;
  uploader: string | null;
  webpageUrl: string;
  presets: Preset[];
  hint?: string | null;
}

interface DownloadTask {
  id: string;
  sourceKey: string;
  url: string;
  title: string;
  thumbnail: string | null;
  format: string;
  formatLabel: string;
  status: TaskStatus;
  progress: number;
  speed: string;
  eta: string;
  filePath?: string;
  missing?: boolean;
  error?: string;
}

interface DownloadJob {
  sourceKey: string;
  url: string;
  format: string;
  formatLabel: string;
  title: string;
  thumbnail: string | null;
}

const TASKS_STORAGE_KEY = "lmf-tasks";
const COOKIE_STORAGE_KEY = "lmf-cookie";

function isPersistedTask(value: unknown): value is DownloadTask {
  if (!value || typeof value !== "object") return false;
  const task = value as Record<string, unknown>;
  return (
    typeof task.id === "string" &&
    typeof task.sourceKey === "string" &&
    typeof task.url === "string" &&
    typeof task.title === "string" &&
    (task.thumbnail === null || typeof task.thumbnail === "string") &&
    typeof task.format === "string" &&
    typeof task.formatLabel === "string" &&
    typeof task.status === "string" &&
    ["downloading", "merging", "done", "error", "canceled"].includes(
      task.status
    ) &&
    typeof task.progress === "number" &&
    typeof task.speed === "string" &&
    typeof task.eta === "string"
  );
}

interface StreamEvent {
  status: "downloading" | "merging" | "done" | "error";
  progress?: number;
  speed?: string;
  eta?: string;
  filePath?: string;
  message?: string;
}

interface HealthState {
  ok: boolean;
  ytdlp: boolean;
  ffmpeg: boolean;
  ytdlpVersion?: string | null;
  ffmpegVersion?: string | null;
  downloadsDir?: string;
}

const DEFAULT_PRESETS: Preset[] = [
  { key: "best", label: "最佳画质 MP4", size: null, available: true },
  { key: "720p", label: "720p MP4", size: null, available: true },
  { key: "mp3", label: "仅音频 MP3", size: null, available: true },
];

const COOKIE_OPTIONS: { value: CookieSource; label: string }[] = [
  { value: "none", label: "关闭" },
  { value: "chrome", label: "Chrome" },
  { value: "safari", label: "Safari" },
];

const GLOBAL_PLATFORMS = PLATFORM_RULES.filter(
  (platform) => platform.region === "global"
);
const CN_PLATFORMS = PLATFORM_RULES.filter(
  (platform) => platform.region === "cn"
);

function readNetworkSettings(): NetworkSettings {
  try {
    const raw = localStorage.getItem(NETWORK_STORAGE_KEY);
    if (!raw) return DEFAULT_NETWORK_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<NetworkSettings>;
    return {
      cnDirect:
        typeof parsed.cnDirect === "boolean"
          ? parsed.cnDirect
          : DEFAULT_NETWORK_SETTINGS.cnDirect,
    };
  } catch {
    return DEFAULT_NETWORK_SETTINGS;
  }
}

function readErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "message" in payload) {
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return fallback;
}

/** 逐块读取 SSE 流并解析 data: 行 */
async function consumeEventStream(
  response: Response,
  onEvent: (event: StreamEvent) => void
) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("无法读取下载进度流");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";

    for (const chunk of chunks) {
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          onEvent(JSON.parse(payload) as StreamEvent);
        } catch {
          // 忽略非 JSON 的心跳内容
        }
      }
    }
  }
}

export default function Home() {
  const [health, setHealth] = useState<HealthState | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [cookie, setCookie] = useState<CookieSource>("none");
  const [network, setNetwork] = useState<NetworkSettings>(
    DEFAULT_NETWORK_SETTINGS
  );
  const [input, setInput] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [media, setMedia] = useState<MediaInfo | null>(null);
  const [selectedFormat, setSelectedFormat] = useState<string>("best");
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [copied, setCopied] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const controllers = useRef(new Map<string, AbortController>());
  const startingRef = useRef(new Set<string>());

  const checkHealth = useCallback(async () => {
    setHealthLoading(true);
    try {
      const response = await fetch("/api/health", { cache: "no-store" });
      setHealth((await response.json()) as HealthState);
    } catch {
      setHealth({ ok: false, ytdlp: false, ffmpeg: false });
    } finally {
      setHealthLoading(false);
    }
  }, []);

  useEffect(() => {
    void checkHealth();
  }, [checkHealth]);

  // 恢复 Cookie 接力与网络分流设置
  useEffect(() => {
    try {
      const saved = localStorage.getItem(COOKIE_STORAGE_KEY);
      if (saved === "chrome" || saved === "safari" || saved === "none") {
        setCookie(saved);
      }
    } catch {
      // 隐私模式下 localStorage 不可用
    }

    const syncNetwork = () => setNetwork(readNetworkSettings());
    syncNetwork();
    window.addEventListener("focus", syncNetwork);
    window.addEventListener("storage", syncNetwork);
    return () => {
      window.removeEventListener("focus", syncNetwork);
      window.removeEventListener("storage", syncNetwork);
    };
  }, []);

  // 恢复下载历史，并把上次未完成的任务标记为中断
  useEffect(() => {
    let cancelled = false;
    let restored: DownloadTask[] = [];

    try {
      const raw = localStorage.getItem(TASKS_STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed)) {
        restored = parsed
          .filter(isPersistedTask)
          .map((task) =>
            task.status === "downloading" || task.status === "merging"
              ? {
                  ...task,
                  status: "error" as const,
                  error: "页面刷新导致下载中断，可点击重试",
                  speed: "",
                  eta: "",
                }
              : task
          );
      }
    } catch {
      restored = [];
    }

    setTasks(restored);
    setHistoryLoaded(true);

    const donePaths = restored
      .filter((task) => task.status === "done" && task.filePath && !task.missing)
      .map((task) => task.filePath as string);

    if (donePaths.length > 0) {
      void fetch("/api/file-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: donePaths }),
      })
        .then((response) => response.json())
        .then((data: { missing?: unknown }) => {
          if (cancelled) return;
          const missing = new Set(
            Array.isArray(data?.missing)
              ? data.missing.filter(
                  (item): item is string => typeof item === "string"
                )
              : []
          );
          if (missing.size === 0) return;
          setTasks((previous) =>
            previous.map((task) =>
              task.filePath && missing.has(task.filePath)
                ? { ...task, missing: true }
                : task
            )
          );
        })
        .catch(() => {
          // 检查失败时保留原状态
        });
    }

    return () => {
      cancelled = true;
    };
  }, []);

  // 任务变化后写入本地历史，防抖避免进度事件频繁写盘
  useEffect(() => {
    if (!historyLoaded) return;
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(
          TASKS_STORAGE_KEY,
          JSON.stringify(tasks)
        );
      } catch {
        // 存储空间不足时忽略
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [tasks, historyLoaded]);

  // 页面卸载时断开所有下载连接，Route Handler 会同步清理子进程
  useEffect(() => {
    const running = controllers.current;
    return () => {
      running.forEach((controller) => controller.abort());
      running.clear();
    };
  }, []);

  const changeCookie = (next: CookieSource) => {
    setCookie(next);
    try {
      localStorage.setItem(COOKIE_STORAGE_KEY, next);
    } catch {
      // 隐私模式下仅当前会话生效
    }
  };

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const url = extractUrlFromText(text);
      setInput(url ?? text.trim());
      setParseError(url ? null : "剪贴板中未找到有效链接");
    } catch {
      setParseError("无法读取剪贴板，请手动粘贴链接");
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    const url = extractUrlFromText(text);
    if (url) {
      event.preventDefault();
      setInput(url);
      setParseError(null);
    }
  };

  const handleParse = async () => {
    if (parsing) return;
    const url = extractUrlFromText(input);
    if (!url) {
      setParseError("未识别到有效链接，请粘贴包含 http(s) 链接的文本");
      return;
    }

    setInput(url);
    setParsing(true);
    setParseError(null);
    setMedia(null);

    try {
      const response = await fetch("/api/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          browserCookie: cookie === "none" ? undefined : cookie,
          network,
        }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        throw new Error(readErrorMessage(payload, "解析失败，请稍后重试"));
      }
      const parsed = payload as { ok: boolean; media: MediaInfo };
      setMedia({ ...parsed.media, sourceUrl: url });
      setSelectedFormat(parsed.media.presets[0]?.key ?? "best");
    } catch (error) {
      setParseError(
        error instanceof Error ? error.message : "解析失败，请稍后重试"
      );
    } finally {
      setParsing(false);
    }
  };

  const applyStreamEvent = (taskId: string, event: StreamEvent) => {
    setTasks((previous) =>
      previous.map((task) => {
        if (task.id !== taskId) return task;
        switch (event.status) {
          case "downloading":
            return {
              ...task,
              status: "downloading",
              progress:
                typeof event.progress === "number"
                  ? event.progress
                  : task.progress,
              speed: event.speed || task.speed,
              eta: event.eta || task.eta,
            };
          case "merging":
            return { ...task, status: "merging", progress: 100, speed: "", eta: "" };
          case "done":
            return {
              ...task,
              status: "done",
              progress: 100,
              speed: "",
              eta: "",
              filePath: event.filePath,
            };
          case "error":
            return { ...task, status: "error", error: event.message || "下载失败" };
          default:
            return task;
        }
      })
    );
  };

  const runDownload = async (job: DownloadJob) => {
    const { sourceKey, url, format, formatLabel, title, thumbnail } = job;
    const lockKey = `${sourceKey}:${format}`;
    const duplicate = tasks.find(
      (task) =>
        task.sourceKey === sourceKey &&
        task.format === format &&
        !task.missing &&
        (task.status === "downloading" ||
          task.status === "merging" ||
          task.status === "done")
    );
    // 同一视频的同一画质只允许一个任务，拦住双击产生的重复队列
    if (duplicate || startingRef.current.has(lockKey)) return;
    startingRef.current.add(lockKey);
    window.setTimeout(() => startingRef.current.delete(lockKey), 1500);

    const taskId = crypto.randomUUID();
    const controller = new AbortController();
    controllers.current.set(taskId, controller);

    setTasks((previous) => [
      {
        id: taskId,
        sourceKey,
        url,
        title,
        thumbnail,
        format,
        formatLabel,
        status: "downloading",
        progress: 0,
        speed: "",
        eta: "",
      },
      ...previous,
    ]);

    try {
      const response = await fetch("/api/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          formatType: format,
          browserCookie: cookie === "none" ? undefined : cookie,
          network,
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const payload: unknown = await response.json().catch(() => null);
        throw new Error(readErrorMessage(payload, `请求失败 (${response.status})`));
      }

      await consumeEventStream(response, (event) =>
        applyStreamEvent(taskId, event)
      );

      // 流正常结束却没有最终状态时，标记为中断
      setTasks((previous) =>
        previous.map((task) =>
          task.id === taskId &&
          (task.status === "downloading" || task.status === "merging")
            ? { ...task, status: "error", error: "下载流意外中断", speed: "", eta: "" }
            : task
        )
      );
    } catch (error) {
      if (controller.signal.aborted) {
        setTasks((previous) =>
          previous.map((task) =>
            task.id === taskId && task.status !== "done"
              ? { ...task, status: "canceled", speed: "", eta: "" }
              : task
          )
        );
      } else {
        setTasks((previous) =>
          previous.map((task) =>
            task.id === taskId
              ? {
                  ...task,
                  status: "error",
                  speed: "",
                  eta: "",
                  error:
                    error instanceof Error ? error.message : "下载失败，请稍后重试",
                }
              : task
          )
        );
      }
    } finally {
      controllers.current.delete(taskId);
    }
  };

  const startDownload = async (format: string) => {
    if (!media) return;

    await runDownload({
      sourceKey: `${media.extractor}:${media.id}`,
      url: media.normalizedUrl || media.sourceUrl,
      format,
      formatLabel:
        media.presets.find((preset) => preset.key === format)?.label ?? format,
      title: media.title,
      thumbnail: media.thumbnail,
    });
  };

  const retryTask = (task: DownloadTask) => {
    // 用新任务替换失败记录，避免同一位置堆叠多条失败历史
    setTasks((previous) => previous.filter((item) => item.id !== task.id));
    void runDownload({
      sourceKey: task.sourceKey,
      url: task.url,
      format: task.format,
      formatLabel: task.formatLabel,
      title: task.title,
      thumbnail: task.thumbnail,
    });
  };

  const cancelTask = (taskId: string) => {
    controllers.current.get(taskId)?.abort();
  };

  const deleteTask = (taskId: string) => {
    controllers.current.get(taskId)?.abort();
    controllers.current.delete(taskId);
    setTasks((previous) => previous.filter((task) => task.id !== taskId));
  };

  const clearHistory = () => {
    const hasActive = tasks.some(
      (task) => task.status === "downloading" || task.status === "merging"
    );

    setTasks((previous) =>
      previous.filter(
        (task) => task.status === "downloading" || task.status === "merging"
      )
    );

    if (!hasActive) {
      try {
        localStorage.removeItem(TASKS_STORAGE_KEY);
      } catch {
        // 隐私模式下忽略
      }
    }
  };

  const openInFinder = async (taskId?: string, filePath?: string) => {
    try {
      const response = await fetch("/api/open-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath }),
      });
      const data = (await response.json().catch(() => null)) as {
        ok?: boolean;
        missing?: boolean;
      } | null;

      if (taskId && data?.missing) {
        setTasks((previous) =>
          previous.map((task) =>
            task.id === taskId ? { ...task, missing: true } : task
          )
        );
      }
    } catch {
      // Finder 打开失败时静默处理
    }
  };

  const copyBrewCommand = async () => {
    try {
      await navigator.clipboard.writeText("brew install yt-dlp ffmpeg");
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // 剪贴板不可用时忽略
    }
  };

  const missingTools = health
    ? [!health.ytdlp && "yt-dlp", !health.ffmpeg && "ffmpeg"].filter(Boolean)
    : [];

  const activeSourceKey = media ? `${media.extractor}:${media.id}` : "";
  const queuedTask = media
    ? tasks.find(
        (task) =>
          task.sourceKey === activeSourceKey &&
          task.format === selectedFormat &&
          !task.missing &&
          (task.status === "downloading" ||
            task.status === "merging" ||
            task.status === "done")
      )
    : undefined;

  const activeTasks = tasks.filter(
    (task) => task.status === "downloading" || task.status === "merging"
  );
  const historyTasks = tasks.filter(
    (task) => task.status !== "downloading" && task.status !== "merging"
  );

  const renderTaskRow = (task: DownloadTask) => (
    <TaskRow
      key={task.id}
      task={task}
      onCancel={cancelTask}
      onRetry={retryTask}
      onDelete={deleteTask}
      onOpen={(taskId, filePath) => void openInFinder(taskId, filePath)}
    />
  );

  return (
    <div className="relative min-h-screen">
      {/* 顶部极淡的白色光晕，模拟 Apple 页面的柔和过渡 */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[480px] bg-[radial-gradient(1200px_480px_at_50%_-80px,rgba(255,255,255,0.95),rgba(255,255,255,0)_70%)]"
      />

      <main className="relative mx-auto w-full max-w-6xl px-5 pb-16 pt-6 sm:px-8">
        {/* 顶部导航 */}
        <header className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-gradient-to-br from-zinc-600 to-zinc-900 text-white shadow-sm">
              <ArrowDownToLine className="h-4 w-4" strokeWidth={2.5} />
            </span>
            <span className="truncate text-[14px] font-semibold tracking-tight text-zinc-900">
              Local Media Fetcher
            </span>
          </div>

          <div
            className="flex shrink-0 items-center gap-1.5"
            title="需要登录态的内容（如 Instagram）请选择已登录的浏览器"
          >
            <span className="hidden text-[10.5px] text-zinc-400 sm:inline">
              Cookies
            </span>
            <div
              role="group"
              aria-label="浏览器 Cookie 接力"
              className="flex items-center rounded-full bg-zinc-200/60 p-0.5"
            >
              {COOKIE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => changeCookie(option.value)}
                  className={`h-7 rounded-full px-2.5 text-[11px] font-medium transition-all ${
                    cookie === option.value
                      ? "bg-white text-zinc-900 shadow-sm"
                      : "text-zinc-500 hover:text-zinc-700"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <Link
              href="/settings"
              aria-label="偏好设置"
              title="偏好设置（网络与主题）"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-zinc-200/80 bg-white text-zinc-500 transition-colors hover:border-zinc-300 hover:text-zinc-800"
            >
              <Settings2 className="h-3.5 w-3.5" />
            </Link>
          </div>
        </header>

        {/* Hero */}
        <section className="mt-12 text-center sm:mt-16">
          <h1 className="mx-auto max-w-xl text-[30px] font-semibold leading-[1.12] tracking-[-0.025em] text-zinc-900 sm:text-[44px]">
            把视频，收进 Downloads。
          </h1>
          <p className="mx-auto mt-3.5 max-w-md text-[13.5px] leading-6 text-zinc-500 sm:text-[15px]">
            粘贴链接，选择画质，即可开始下载。
          </p>
          <div className="mt-4 flex items-center justify-center gap-1.5 font-mono text-[9.5px] tracking-[0.08em] text-zinc-400">
            <span className="rounded-full border border-zinc-200/70 bg-white/60 px-2 py-0.5">
              [ YT-DLP + FFMPEG ]
            </span>
          </div>
        </section>

        {/* 依赖缺失引导 */}
        {!healthLoading && health && !health.ok && (
          <section className="mt-8 overflow-hidden rounded-[20px] border border-amber-200/80 bg-amber-50/80 p-4">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-600">
                <AlertTriangle className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-amber-900">
                  下载引擎尚未就绪
                </p>
                <p className="mt-1 text-[12px] leading-5 text-amber-800/80">
                  未检测到 {missingTools.join(" 与 ")}，安装后点击重新检测，无需重启服务。
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <code className="rounded-lg border border-amber-200 bg-white px-2.5 py-1.5 font-mono text-[11.5px] text-amber-900">
                    brew install yt-dlp ffmpeg
                  </code>
                  <button
                    type="button"
                    onClick={() => void copyBrewCommand()}
                    className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-white px-2.5 py-1.5 text-[11px] font-medium text-amber-800 transition-colors hover:bg-amber-100/60"
                  >
                    {copied ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    {copied ? "已复制" : "复制"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void checkHealth()}
                    disabled={healthLoading}
                    className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-white px-2.5 py-1.5 text-[11px] font-medium text-amber-800 transition-colors hover:bg-amber-100/60 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white"
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${healthLoading ? "animate-spin" : ""}`}
                    />
                    重新检测
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* 链接输入 */}
        <section className="mt-8">
          <div className="rounded-[22px] border border-zinc-200/70 bg-white p-4 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_12px_32px_-20px_rgba(16,24,40,0.25)]">
            <div className="space-y-2 border-b border-zinc-100 pb-3">
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
                <span className="mr-0.5 text-[10.5px] font-medium text-zinc-400">
                  国际
                </span>
                {GLOBAL_PLATFORMS.map((platform) => (
                  <PlatformBadge key={platform.id} platform={platform} />
                ))}
                <span className="mx-1 hidden h-3 w-px bg-zinc-200 sm:inline-block" />
                <span className="mr-0.5 text-[10.5px] font-medium text-zinc-400">
                  国内
                </span>
                {CN_PLATFORMS.map((platform) => (
                  <PlatformBadge key={platform.id} platform={platform} />
                ))}
              </div>
            </div>

            <div className="relative mt-3">
              <Link2 className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              <input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onPaste={handlePaste}
                onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void handleParse();
                  }
                }}
                placeholder="粘贴视频链接，混有分享文案也可以"
                spellCheck={false}
                className="h-[52px] w-full rounded-2xl border border-transparent bg-zinc-100/70 pl-11 pr-4 font-mono text-[12.5px] text-zinc-800 outline-none transition-all placeholder:font-sans placeholder:text-[13px] placeholder:text-zinc-400 focus:border-brand/30 focus:bg-white focus:ring-4 focus:ring-brand/5"
              />
            </div>

            <div className="mt-2.5 flex items-center justify-between gap-2 px-1">
              <p className="hidden text-[10.5px] text-zinc-400 sm:block">
                支持中英文分享口令自动提取 · 国内平台默认直连 · 回车解析
              </p>
              <div className="flex flex-1 gap-2 sm:flex-none">
                <button
                  type="button"
                  onClick={() => void pasteFromClipboard()}
                  disabled={parsing}
                  className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-full border border-zinc-200 bg-white px-4 text-[12px] font-medium text-zinc-600 transition-colors hover:border-zinc-300 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-zinc-200 disabled:hover:bg-white sm:flex-none"
                >
                  <ClipboardPaste className="h-3.5 w-3.5" />
                  粘贴
                </button>
                <button
                  type="button"
                  onClick={() => void handleParse()}
                  disabled={parsing || !input.trim()}
                  className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-full bg-brand px-4 text-[12px] font-semibold text-white shadow-sm transition-all hover:bg-brand-strong active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none disabled:hover:bg-brand disabled:active:scale-100 sm:flex-none"
                >
                  {parsing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ArrowDownToLine className="h-3.5 w-3.5" />
                  )}
                  {parsing ? "解析中…" : "解析链接"}
                </button>
              </div>
            </div>
          </div>

          {parseError && (
            <div className="mt-3 flex items-start gap-2 rounded-2xl border border-red-100 bg-red-50/70 px-3.5 py-2.5 text-[11.5px] leading-5 text-red-600">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{parseError}</span>
            </div>
          )}
        </section>

        {/* 媒体预览 */}
        {media && (
          <section className="mt-4 overflow-hidden rounded-[22px] border border-zinc-200/70 bg-white p-3 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_12px_32px_-20px_rgba(16,24,40,0.25)]">
            <div className="flex gap-3.5 p-1">
              <div className="relative aspect-video w-32 shrink-0 self-start overflow-hidden rounded-xl bg-zinc-100 sm:w-52">
                {media.thumbnail ? (
                  // 外链封面使用原生 img，避免 next/image 域名白名单限制
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={media.thumbnail}
                    alt={media.title}
                    referrerPolicy="no-referrer"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-zinc-300">
                    <ArrowDownToLine className="h-6 w-6" />
                  </div>
                )}
                <span className="absolute bottom-1.5 right-1.5 rounded bg-black/60 px-1 py-0.5 font-mono text-[9px] text-white">
                  {media.duration}
                </span>
              </div>

              <div className="min-w-0 flex-1 pt-0.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="inline-block rounded-full bg-zinc-100 px-2 py-0.5 font-mono text-[9.5px] tracking-wide text-zinc-500">
                    {media.extractor}
                  </span>
                  {media.region === "cn" && network.cnDirect && (
                    <span className="inline-block rounded-full bg-emerald-50 px-2 py-0.5 text-[9.5px] font-medium text-emerald-600">
                      国内直连
                    </span>
                  )}
                </div>
                <h2 className="mt-2 line-clamp-2 text-[14.5px] font-semibold leading-6 text-zinc-900">
                  {media.title}
                </h2>
                <p className="mt-0.5 truncate font-mono text-[10.5px] text-zinc-400">
                  {media.uploader || media.webpageUrl}
                </p>
              </div>
            </div>

            {media.hint && (
              <div className="mx-1 mt-2.5 flex items-start gap-1.5 rounded-xl border border-amber-200/70 bg-amber-50/70 px-3 py-2 text-[11px] leading-4 text-amber-700">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                <span>{media.hint}</span>
              </div>
            )}

            <div className="mt-3 px-1 pb-0.5">
              <p className="text-[10.5px] font-medium text-zinc-400">选择画质</p>
              <div className="mt-1.5 flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="flex flex-1 flex-wrap gap-1.5">
                  {(media.presets.length ? media.presets : DEFAULT_PRESETS).map(
                    (preset) => {
                      const active = selectedFormat === preset.key;
                      return (
                        <button
                          key={preset.key}
                          type="button"
                          disabled={!preset.available}
                          onClick={() => setSelectedFormat(preset.key)}
                          className={`min-w-[94px] rounded-xl border px-3 py-2 text-left transition-all disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-zinc-200 disabled:hover:bg-white ${
                            active
                              ? "border-brand bg-brand/[0.06]"
                              : "border-zinc-200 bg-white hover:border-zinc-300"
                          }`}
                        >
                          <span
                            className={`block text-[11px] font-medium ${
                              active ? "text-brand-strong" : "text-zinc-700"
                            }`}
                          >
                            {preset.label}
                          </span>
                          <span className="mt-0.5 block font-mono text-[9.5px] text-zinc-400">
                            {preset.size ?? "—"}
                          </span>
                        </button>
                      );
                    }
                  )}
                </div>

                <button
                  type="button"
                  disabled={Boolean(queuedTask)}
                  onClick={() => void startDownload(selectedFormat)}
                  title={
                    queuedTask
                      ? queuedTask.status === "done"
                        ? "该画质已下载，可在下载队列中定位文件"
                        : "该画质已在下载队列中"
                      : undefined
                  }
                  className="inline-flex h-10 w-full shrink-0 items-center justify-center gap-2 rounded-full bg-brand text-[12.5px] font-semibold text-white shadow-sm transition-all hover:bg-brand-strong active:scale-[0.995] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none disabled:hover:bg-brand disabled:active:scale-100 sm:w-36"
                >
                  {queuedTask ? (
                    queuedTask.status === "done" ? (
                      <>
                        <Check className="h-4 w-4" />
                        已下载
                      </>
                    ) : (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        下载中
                      </>
                    )
                  ) : (
                    <>
                      <ArrowDownToLine className="h-4 w-4" />
                      立即下载
                    </>
                  )}
                </button>
              </div>
            </div>
          </section>
        )}

        {/* 下载队列：仅进行中的任务 */}
        <section className="mt-8">
          <div className="mb-2.5 flex items-center justify-between gap-2 px-1">
            <div className="flex items-center gap-2">
              <h2 className="text-[15px] font-semibold tracking-tight text-zinc-900">
                下载队列
              </h2>
              {activeTasks.length > 0 && (
                <span className="rounded-full bg-zinc-200/60 px-1.5 py-0.5 font-mono text-[9.5px] text-zinc-500">
                  {activeTasks.length}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => void openInFinder()}
              title="在 Finder 中打开 ~/Downloads"
              className="inline-flex items-center gap-1 rounded-full px-2 py-1 font-mono text-[10px] text-zinc-400 transition-colors hover:bg-white hover:text-zinc-600"
            >
              <FolderOpen className="h-3 w-3" />
              ~/Downloads
            </button>
          </div>

          {activeTasks.length === 0 ? (
            <div className="rounded-[20px] border border-dashed border-zinc-300/70 bg-white/50 px-6 py-8 text-center">
              <ArrowDownToLine className="mx-auto h-5 w-5 text-zinc-300" />
              <p className="mt-2 text-[11.5px] text-zinc-400">
                {historyTasks.length > 0
                  ? "当前没有进行中的下载"
                  : "还没有任务。解析链接后点击「立即下载」。"}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-zinc-100 overflow-hidden rounded-[20px] border border-zinc-200/70 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_12px_32px_-20px_rgba(16,24,40,0.2)]">
              {activeTasks.map(renderTaskRow)}
            </div>
          )}
        </section>

        {/* 下载历史：已完成 / 失败 / 已取消 */}
        {historyTasks.length > 0 && (
          <section className="mt-7">
            <div className="mb-2.5 flex items-center justify-between gap-2 px-1">
              <div className="flex items-center gap-2">
                <h2 className="text-[15px] font-semibold tracking-tight text-zinc-900">
                  下载历史
                </h2>
                <span className="rounded-full bg-zinc-200/60 px-1.5 py-0.5 font-mono text-[9.5px] text-zinc-500">
                  {historyTasks.length}
                </span>
              </div>
              <button
                type="button"
                onClick={clearHistory}
                title="清空历史记录，不会删除已下载文件"
                className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] text-zinc-400 transition-colors hover:bg-white hover:text-zinc-600"
              >
                <Trash2 className="h-3 w-3" />
                清空历史
              </button>
            </div>
            <div className="max-h-[380px] divide-y divide-zinc-100 overflow-y-auto rounded-[20px] border border-zinc-200/70 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_12px_32px_-20px_rgba(16,24,40,0.2)]">
              {historyTasks.map(renderTaskRow)}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function TaskRow({
  task,
  onCancel,
  onRetry,
  onDelete,
  onOpen,
}: {
  task: DownloadTask;
  onCancel: (taskId: string) => void;
  onRetry: (task: DownloadTask) => void;
  onDelete: (taskId: string) => void;
  onOpen: (taskId: string, filePath?: string) => void;
}) {
  const active = task.status === "downloading" || task.status === "merging";
  const done = task.status === "done";
  const progress = done || task.status === "merging" ? 100 : task.progress;

  return (
    <div className="flex items-start gap-3 px-4 py-3.5">
      <div className="h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-zinc-100">
        {task.thumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={task.thumbnail}
            alt=""
            referrerPolicy="no-referrer"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-zinc-300">
            <ArrowDownToLine className="h-4 w-4" />
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-[12.5px] font-medium text-zinc-800">
            {task.title}
          </p>
          <span className="shrink-0 font-mono text-[9.5px] text-zinc-400">
            {task.formatLabel}
          </span>
        </div>

        <div className="mt-2 flex items-center gap-2.5">
          <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-zinc-100">
            <div
              className={`h-full rounded-full transition-[width] duration-300 ease-out ${
                done
                  ? "bg-emerald-500"
                  : task.status === "merging"
                    ? "animate-pulse bg-brand"
                    : task.status === "error" || task.status === "canceled"
                      ? "bg-zinc-300"
                      : "bg-brand"
              }`}
              style={{ width: `${Math.min(100, Math.max(progress, 0))}%` }}
            />
          </div>
          <span
            className={`shrink-0 font-mono text-[10.5px] tabular-nums ${
              done ? "text-emerald-600" : "text-zinc-500"
            }`}
          >
            {Math.round(progress)}%
          </span>
        </div>

        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 text-[11px]">
            {task.status === "downloading" && (
              <span className="text-zinc-500">下载中</span>
            )}
            {task.status === "merging" && (
              <>
                <Loader2 className="h-3 w-3 animate-spin text-zinc-400" />
                <span className="text-zinc-500">合并 / 转码中…</span>
              </>
            )}
            {done && task.missing && (
              <>
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                <span className="text-amber-600">文件已被删除</span>
              </>
            )}
            {done && !task.missing && (
              <>
                <Check className="h-3.5 w-3.5 text-emerald-500" />
                <span className="text-emerald-600">已完成</span>
              </>
            )}
            {task.status === "canceled" && (
              <span className="text-zinc-400">已取消</span>
            )}
            {task.status === "error" && (
              <>
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-500" />
                <span className="truncate text-red-600">
                  {task.error || "下载失败"}
                </span>
              </>
            )}
          </span>

          <span className="flex shrink-0 items-center gap-2 font-mono text-[10px] text-zinc-400">
            {task.status === "downloading" && task.speed && (
              <span>{task.speed}</span>
            )}
            {task.status === "downloading" && task.eta && (
              <span>ETA {task.eta}</span>
            )}
            {active && (
              <button
                type="button"
                onClick={() => onCancel(task.id)}
                title="取消任务"
                className="rounded-full p-1 text-zinc-300 transition-colors hover:bg-zinc-100 hover:text-zinc-500"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
            {task.status === "error" && (
              <button
                type="button"
                onClick={() => onRetry(task)}
                className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-white px-2 py-1 text-[10px] font-medium text-zinc-600 transition-colors hover:border-zinc-300 hover:bg-zinc-50"
              >
                <RefreshCw className="h-3 w-3" />
                重试
              </button>
            )}
            {done && (
              <button
                type="button"
                disabled={task.missing}
                onClick={() => onOpen(task.id, task.filePath)}
                title={
                  task.missing ? "文件可能已被删除或移动" : "在 Finder 中显示"
                }
                className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-white px-2 py-1 text-[10px] font-medium text-zinc-600 transition-colors hover:border-zinc-300 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:hover:border-zinc-200 disabled:hover:bg-white"
              >
                <FolderOpen className="h-3 w-3" />
                {task.missing ? "文件不存在" : "在 Finder 中显示"}
              </button>
            )}
            {!active && (
              <button
                type="button"
                onClick={() => onDelete(task.id)}
                title="删除记录（不会删除文件）"
                aria-label="删除记录"
                className="rounded-full p-1 text-zinc-300 transition-colors hover:bg-zinc-100 hover:text-zinc-500"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

function PlatformBadge({ platform }: { platform: PlatformRule }) {
  const needsCookie = platform.cookiePolicy === "required";
  const hint =
    platform.cookieHint ||
    (platform.region === "cn"
      ? `${platform.label}：公开内容免登录，国内自动直连`
      : `${platform.label}：公开内容免登录`);

  return (
    <a
      href={platform.homeUrl}
      target="_blank"
      rel="noopener noreferrer"
      title={`${hint}（点击打开 ${platform.label}）`}
      className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-zinc-200/70 bg-zinc-50/80 py-[3px] pl-1 pr-2 text-[10.5px] font-medium text-zinc-600 transition-all hover:border-zinc-300 hover:bg-white hover:text-zinc-900 hover:shadow-sm active:scale-[0.98]"
    >
      <span
        style={{ background: platform.tileBg }}
        className="flex h-4 w-4 items-center justify-center rounded-[5px] text-[8px] font-semibold leading-none text-white"
      >
        {platform.mark}
      </span>
      {platform.label}
      {needsCookie && (
        <>
          <Lock className="h-2.5 w-2.5 text-amber-500" />
          <span className="text-[9px] text-amber-600">需Cookie</span>
        </>
      )}
    </a>
  );
}
