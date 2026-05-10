import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/ipc/manager";

interface AiProgress {
  currentFile: string;
  isActive: boolean;
  isModelLoaded: boolean;
  phase: "loading" | "embedding" | "complete";
  processed: number;
  total: number;
}

interface AiProgressBarProps {
  onComplete?: () => void;
}

export function AiProgressBar({ onComplete }: AiProgressBarProps) {
  const { t } = useTranslation();
  const [progress, setProgress] = useState<AiProgress | null>(null);
  const [paused, setPaused] = useState(false);

  const fetchProgress = useCallback(async () => {
    try {
      const result = await ipc.client.photos.getAiProgress({});
      setProgress(result as any as AiProgress);
      return result as any as AiProgress;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval>;
    fetchProgress().then((p) => {
      if (p?.isActive) {
        timer = setInterval(fetchProgress, 500);
      }
    });
    return () => {
      if (timer) {
        clearInterval(timer);
      }
    };
  }, [fetchProgress]);

  // Restart polling when progress changes
  useEffect(() => {
    if (!progress?.isActive && progress?.phase === "complete") {
      onComplete?.();
    }
    if (progress?.isActive && paused) {
      // Resume was clicked, restart polling
      const timer = setInterval(fetchProgress, 500);
      return () => clearInterval(timer);
    }
  }, [progress, paused, fetchProgress, onComplete]);

  async function handleStart() {
    await ipc.client.photos.startAiIndexing({});
    setPaused(false);
    setProgress({
      processed: 0,
      total: 0,
      phase: "loading",
      currentFile: "",
      isActive: true,
      isModelLoaded: false,
    });
    const timer = setInterval(fetchProgress, 500);
    // Store timer cleanup
    setTimeout(() => {
      const checkAndStop = setInterval(async () => {
        const p = await fetchProgress();
        if (!p?.isActive) {
          clearInterval(checkAndStop);
          clearInterval(timer);
        }
      }, 1000);
    }, 0);
  }

  async function handlePause() {
    await ipc.client.photos.stopAiIndexing({});
    setPaused(true);
  }

  async function handleResume() {
    await ipc.client.photos.startAiIndexing({});
    setPaused(false);
  }

  if (
    !progress ||
    (!progress.isActive &&
      progress.phase === "complete" &&
      progress.processed === 0)
  ) {
    return (
      <button
        className="mt-2 w-full rounded-[6px] bg-[#5e6ad2]/10 px-3 py-1.5 font-[510] text-[#5e6ad2] text-[12px] transition-colors hover:bg-[#5e6ad2]/15 hover:text-[#7c7fe0]"
        onClick={handleStart}
      >
        {t("aiIndexingStarted")}
      </button>
    );
  }

  const pct =
    progress.total > 0
      ? Math.round((progress.processed / progress.total) * 100)
      : 0;
  const phaseLabel =
    progress.phase === "loading"
      ? "加载模型中..."
      : progress.phase === "complete"
        ? paused
          ? "已暂停"
          : "完成!"
        : `正在索引 ${progress.processed}/${progress.total}`;

  return (
    <div className="mt-2 rounded-[6px] border border-[#2c2c30] bg-[#1c1e22] px-2 py-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[#a1a1aa] text-[11px]">{phaseLabel}</span>
        <span className="font-[510] text-[#5e6ad2] text-[11px]">{pct}%</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-[#121214]">
        <div
          className="h-full rounded-full bg-[#5e6ad2] transition-all duration-300 ease-out"
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
              className="flex-1 rounded-[4px] px-2 py-1 font-[510] text-[#5e6ad2] text-[11px] transition-colors hover:bg-[#5e6ad2]/10"
              onClick={handleResume}
            >
              继续
            </button>
          ) : (
            <button
              className="flex-1 rounded-[4px] px-2 py-1 font-[510] text-[#a1a1aa] text-[11px] transition-colors hover:bg-white/5 hover:text-[#f7f8f8]"
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
