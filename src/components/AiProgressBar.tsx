import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/ipc/manager";

interface AiProgress {
  currentFile: string;
  error?: string;
  isActive: boolean;
  isModelLoaded: boolean;
  phase: "idle" | "loading" | "embedding" | "complete" | "error";
  processed: number;
  total: number;
}

export function AiProgressBar() {
  const { t } = useTranslation();
  const [progress, setProgress] = useState<AiProgress | null>(null);
  const [paused, setPaused] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const pollingRef = useRef(false);

  const fetchProgress = useCallback(async () => {
    try {
      const result = await ipc.client.photos.getAiProgress({});
      return result as any as AiProgress;
    } catch {
      return null;
    }
  }, []);

  // One-time initial fetch on mount
  useEffect(() => {
    fetchProgress().then((p) => {
      if (p) setProgress(p);
    });
  }, [fetchProgress]);

  // Poll while active
  useEffect(() => {
    if (!progress?.isActive || pollingRef.current) return;

    pollingRef.current = true;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      const p = await fetchProgress();
      if (p) setProgress(p);
      if (p?.isActive) {
        timer = setTimeout(poll, 500);
      } else {
        pollingRef.current = false;
      }
    };

    timer = setTimeout(poll, 500);

    return () => {
      clearTimeout(timer);
      pollingRef.current = false;
    };
  }, [progress?.isActive, fetchProgress]);

  useEffect(() => {
    if (!progress) return;
    if (progress.phase === "error") {
      setLastError(progress.error || "AI 初始化失败");
    }
  }, [progress]);

  async function handleStart() {
    setLastError(null);
    await ipc.client.photos.startAiIndexing({});
    setPaused(false);
    // Immediately poll — the backend will have isEmbedding=true now
    const p = await fetchProgress();
    if (p) setProgress(p);
  }

  async function handlePause() {
    await ipc.client.photos.stopAiIndexing({});
    setPaused(true);
    // Fetch final state after stopping
    const p = await fetchProgress();
    if (p) setProgress(p);
  }

  async function handleResume() {
    setLastError(null);
    await ipc.client.photos.startAiIndexing({});
    setPaused(false);
    const p = await fetchProgress();
    if (p) setProgress(p);
  }

  // Error state: show retry button
  if (progress?.phase === "error" || lastError) {
    return (
      <div className="mt-2 rounded-[6px] border border-[#e5484d]/30 bg-[#e5484d]/5 px-3 py-2">
        <p className="text-[#e5484d] text-[11px]">{lastError}</p>
        <p className="mt-1 text-[#6b6b75] text-[10px]">
          国内用户可设置 HuggingFace 镜像：启动时设置环境变量
          <code className="mx-0.5 rounded-[4px] bg-card px-1 text-[#a1a1aa] text-[10px]">
            HF_MIRROR=hf-mirror.com
          </code>
        </p>
        <button
          className="mt-2 w-full rounded-[4px] bg-primary/10 px-2 py-1 font-[510] text-primary text-[11px] transition-colors hover:bg-primary/20"
          onClick={handleStart}
        >
          重试
        </button>
      </div>
    );
  }

  // Idle state: show start button (no active embedding, nothing processed yet)
  if (
    !progress ||
    (!progress.isActive && progress.processed === 0 && progress.phase !== "complete")
  ) {
    return (
      <button
        className="mt-2 w-full rounded-[6px] bg-primary/10 px-3 py-1.5 font-[510] text-primary text-[12px] transition-colors hover:bg-primary/15"
        onClick={handleStart}
      >
        开始AI索引
      </button>
    );
  }

  const pct =
    progress.total > 0
      ? Math.round((progress.processed / progress.total) * 100)
      : 0;
  const phaseLabel =
    progress.phase === "loading"
      ? "加载 CLIP 模型中... (首次约 87MB)"
      : progress.phase === "complete"
        ? paused
          ? "已暂停"
          : "完成!"
        : `正在索引 ${progress.processed}/${progress.total}`;

  return (
    <div className="mt-2 rounded-[6px] border border-[#2c2c30] bg-[#1c1e22] px-2 py-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[#a1a1aa] text-[11px]">{phaseLabel}</span>
        <span className="font-[510] text-primary text-[11px]">{pct}%</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-[#121214]">
        <div
          className="h-full rounded-full bg-primary transition-all duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      {progress.currentFile && (
        <p className="mt-1 truncate text-[#6b6b75] text-[10px]">
          {progress.currentFile}
        </p>
      )}
      {progress.phase !== "complete" && (
        <div className="mt-2 flex gap-1">
          {paused ? (
            <button
              className="flex-1 rounded-[4px] px-2 py-1 font-[510] text-primary text-[11px] transition-colors hover:bg-primary/10"
              onClick={handleResume}
            >
              继续
            </button>
          ) : (
            <button
              className="flex-1 rounded-[4px] px-2 py-1 font-[510] text-[#a1a1aa] text-[11px] transition-colors hover:bg-foreground/5 hover:text-foreground"
              onClick={handlePause}
            >
              暂停
            </button>
          )}
        </div>
      )}
    </div>
  );
}
