import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/ipc/manager";

interface AiProgress {
  processed: number;
  total: number;
  phase: "loading" | "embedding" | "complete";
  currentFile: string;
  isActive: boolean;
  isModelLoaded: boolean;
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
    } catch { return null; }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval>;
    fetchProgress().then((p) => {
      if (p?.isActive) {
        timer = setInterval(fetchProgress, 500);
      }
    });
    return () => { if (timer) clearInterval(timer); };
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
    setProgress({ processed: 0, total: 0, phase: "loading", currentFile: "", isActive: true, isModelLoaded: false });
    const timer = setInterval(fetchProgress, 500);
    // Store timer cleanup
    setTimeout(() => {
      const checkAndStop = setInterval(async () => {
        const p = await fetchProgress();
        if (!p?.isActive) { clearInterval(checkAndStop); clearInterval(timer); }
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

  if (!progress || (!progress.isActive && progress.phase === "complete" && progress.processed === 0)) {
    return (
      <button
        onClick={handleStart}
        className="w-full mt-2 px-3 py-1.5 text-[12px] font-[510] text-[#5e6ad2] hover:text-[#7c7fe0] bg-[#5e6ad2]/10 hover:bg-[#5e6ad2]/15 rounded-[6px] transition-colors"
      >
        {t("aiIndexingStarted")}
      </button>
    );
  }

  const pct = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;
  const phaseLabel = progress.phase === "loading" ? "加载模型中..."
    : progress.phase === "complete" ? (paused ? "已暂停" : "完成!")
    : `正在索引 ${progress.processed}/${progress.total}`;

  return (
    <div className="mt-2 px-2 py-2 rounded-[6px] bg-[#1c1e22] border border-[#2c2c30]">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] text-[#a1a1aa]">{phaseLabel}</span>
        <span className="text-[11px] font-[510] text-[#5e6ad2]">{pct}%</span>
      </div>
      <div className="h-1 rounded-full bg-[#121214] overflow-hidden">
        <div
          className="h-full rounded-full bg-[#5e6ad2] transition-all duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      {progress.currentFile && (
        <p className="text-[10px] text-[#6b6b75] mt-1 truncate">{progress.currentFile}</p>
      )}
      {progress.phase !== "complete" && (
        <div className="flex gap-1 mt-2">
          {paused ? (
            <button
              onClick={handleResume}
              className="flex-1 px-2 py-1 text-[11px] font-[510] text-[#5e6ad2] hover:bg-[#5e6ad2]/10 rounded-[4px] transition-colors"
            >
              继续
            </button>
          ) : (
            <button
              onClick={handlePause}
              className="flex-1 px-2 py-1 text-[11px] font-[510] text-[#a1a1aa] hover:text-[#f7f8f8] hover:bg-white/5 rounded-[4px] transition-colors"
            >
              暂停
            </button>
          )}
        </div>
      )}
    </div>
  );
}
