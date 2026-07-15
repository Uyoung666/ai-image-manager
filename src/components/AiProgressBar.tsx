import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/ipc/manager";

interface AiProgress {
  controlState?: "idle" | "running" | "pausing" | "paused" | "cancelling";
  currentFile: string;
  downloadPercent?: number;
  error?: string;
  isActive: boolean;
  isModelLoaded: boolean;
  isPaused?: boolean;
  loadingStartedAt?: number | null;
  phase:
    | "idle"
    | "loading"
    | "embedding"
    | "tagging"
    | "complete"
    | "error"
    | "tag-error"
    | "repairing";
  processed: number;
  repairReason?: string;
  total: number;
}

export function AiProgressBar({ disabled = false }: { disabled?: boolean }) {
  const { t } = useTranslation();
  const [progress, setProgress] = useState<AiProgress | null>(null);
  const [isMutating, setIsMutating] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const pollingRef = useRef(false);

  const fetchProgress = useCallback(async () => {
    try {
      const result = await ipc.client.photos.getAiProgress({});
      return result as AiProgress;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    fetchProgress().then((p) => {
      if (p) {
        setProgress(p);
      }
    });
  }, [fetchProgress]);

  // Poll while active (fast: 500ms)
  useEffect(() => {
    if (!progress?.isActive || pollingRef.current) {
      return;
    }

    pollingRef.current = true;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      const p = await fetchProgress();
      if (p) {
        setProgress(p);
      }
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

  // Slow poll when idle — detects auto-started embeddings (e.g. after folder import)
  const slowPollRef = useRef(false);
  useEffect(() => {
    if (progress?.isActive || slowPollRef.current) {
      return;
    }

    slowPollRef.current = true;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      const p = await fetchProgress();
      if (p) {
        setProgress(p);
      }
      // Stop slow poll once embedding is detected (fast poll takes over)
      if (p?.isActive) {
        slowPollRef.current = false;
        return;
      }
      timer = setTimeout(poll, 2000);
    };

    timer = setTimeout(poll, 2000);

    return () => {
      clearTimeout(timer);
      slowPollRef.current = false;
    };
  }, [progress?.isActive, fetchProgress]);

  useEffect(() => {
    if (!progress) {
      return;
    }
    if (progress.phase === "error" || progress.phase === "tag-error") {
      setLastError(
        progress.error ||
          (progress.phase === "tag-error"
            ? t("aiTagsFailed")
            : t("aiInitFailed"))
      );
    }
  }, [progress, t]);

  async function runProgressMutation(action: () => Promise<unknown>) {
    setIsMutating(true);
    try {
      await action();
      const p = await fetchProgress();
      if (p) {
        setProgress(p);
      } else {
        setProgress(null);
      }
    } finally {
      setIsMutating(false);
    }
  }

  async function handleStart() {
    if (disabled) {
      return;
    }
    setLastError(null);
    await runProgressMutation(() => ipc.client.photos.startAiIndexing({}));
  }

  async function handlePause() {
    await runProgressMutation(() => ipc.client.photos.pauseAiIndexing({}));
  }

  async function handleResume() {
    setLastError(null);
    await runProgressMutation(() => ipc.client.photos.resumeAiIndexing({}));
  }

  async function handleCancel() {
    await runProgressMutation(() => ipc.client.photos.cancelAiIndexing({}));
  }

  if (
    progress?.phase === "error" ||
    progress?.phase === "tag-error" ||
    lastError
  ) {
    const isNetworkError =
      lastError?.includes("ENOTFOUND") ||
      lastError?.includes("timeout") ||
      lastError?.includes("ETIMEDOUT") ||
      lastError?.includes("fetch failed") ||
      lastError?.includes("network");

    return (
      <div className="mt-2 rounded-[6px] border border-danger/30 bg-danger/5 px-3 py-2">
        <p className="font-medium text-[11px] text-danger">{lastError}</p>

        {isNetworkError ? (
          <div className="mt-2 space-y-2">
            <p className="text-[10px] text-muted-foreground">
              {t("aiNetworkErrorHint")}
            </p>
            <div className="rounded-[4px] border border-border bg-card p-2">
              <p className="mb-1 text-[10px] text-muted-foreground">
                {t("aiMirrorRecommendation")}
              </p>
              <button
                className="w-full rounded-[4px] bg-primary/10 px-2 py-1 text-[10px] text-primary hover:bg-primary/20"
                onClick={() => {
                  window.open("https://hf-mirror.com", "_blank");
                }}
                type="button"
              >
                {t("aiOpenMirrorSite")}
              </button>
              <p className="mt-1.5 text-[9px] text-muted-foreground/70">
                {t("aiMirrorSettingsHint")}
              </p>
            </div>
          </div>
        ) : (
          <p className="mt-1 text-[10px] text-muted-foreground">
            {t("aiMirrorHint")}
            <code className="mx-0.5 rounded-[4px] bg-card px-1 text-[10px] text-muted-foreground">
              HF_MIRROR=hf-mirror.com
            </code>
          </p>
        )}

        <button
          className="mt-2 w-full rounded-[4px] bg-primary/10 px-2 py-1 font-medium text-[11px] text-primary transition-colors hover:bg-primary/20"
          onClick={handleStart}
          type="button"
        >
          {t("aiRetry")}
        </button>
      </div>
    );
  }

  // Idle state: show start button (no active embedding, nothing processed yet)
  if (
    !progress ||
    (!progress.isActive &&
      progress.processed === 0 &&
      progress.phase !== "complete")
  ) {
    return (
      <button
        className="mt-2 w-full rounded-[6px] bg-primary/10 px-3 py-1.5 font-medium text-[12px] text-primary transition-colors hover:bg-primary/15 disabled:pointer-events-none disabled:opacity-40"
        disabled={disabled || isMutating}
        onClick={handleStart}
        type="button"
      >
        {t("aiStartIndex")}
      </button>
    );
  }

  // Complete state: show re-index button for newly added photos
  if (!progress.isActive && progress.phase === "complete") {
    return (
      <div className="mt-2 rounded-[6px] border border-border bg-card px-2 py-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">
            {t("aiIndexComplete", {
              processed: progress.processed,
              total: progress.total,
            })}
          </span>
          <span className="font-medium text-[11px] text-primary">
            {progress.total > 0
              ? `${Math.round((progress.processed / progress.total) * 100)}%`
              : "100%"}
          </span>
        </div>
        <button
          className="mt-2 w-full rounded-[4px] bg-primary/10 px-2 py-1 font-medium text-[11px] text-primary transition-colors hover:bg-primary/20"
          disabled={isMutating}
          onClick={handleStart}
          type="button"
        >
          {t("aiIndexNewPhotos")}
        </button>
      </div>
    );
  }

  let pct = 0;
  if (progress.phase === "loading" && progress.downloadPercent != null) {
    pct = progress.downloadPercent;
  } else if (progress.total > 0) {
    pct = Math.round((progress.processed / progress.total) * 100);
  }
  const controlState = progress.controlState ?? "idle";
  const paused =
    progress.isPaused ||
    controlState === "paused" ||
    controlState === "pausing";
  const cancelling = controlState === "cancelling";
  let phaseLabel = t("aiIndexingProgress", {
    processed: progress.processed,
    total: progress.total,
  });
  if (cancelling) {
    phaseLabel = t("cancel");
  } else if (paused) {
    phaseLabel = t("aiPaused");
  } else if (progress.phase === "repairing") {
    phaseLabel = t("aiRepairingIndex");
  } else if (progress.phase === "tagging") {
    phaseLabel = t("tagGeneratingProgress", {
      processed: progress.processed,
      total: progress.total,
    });
  } else if (progress.phase === "loading") {
    phaseLabel =
      progress.downloadPercent == null
        ? t("aiLoadingClip")
        : t("aiLoadingClip", { percent: progress.downloadPercent });
  } else if (progress.phase === "complete") {
    phaseLabel = t("aiComplete");
  }

  return (
    <div className="mt-2 rounded-[6px] border border-border bg-card px-2 py-2">
      {progress.repairReason && (
        <p className="mb-1.5 rounded-[4px] bg-primary/10 px-2 py-1 text-[10px] text-primary leading-relaxed">
          {progress.repairReason}
        </p>
      )}
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">{phaseLabel}</span>
        <span className="font-medium text-[11px] text-primary">{pct}%</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full rounded-full bg-primary transition-all duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      {progress.currentFile && (
        <p className="mt-1 truncate text-[10px] text-muted-foreground">
          {progress.currentFile}
        </p>
      )}
      {progress.phase === "embedding" && (
        <div className="mt-2 flex gap-1">
          {paused ? (
            <>
              <button
                className="flex-1 rounded-[4px] px-2 py-1 font-medium text-[11px] text-primary transition-colors hover:bg-primary/10"
                disabled={
                  isMutating || cancelling || controlState === "pausing"
                }
                onClick={handleResume}
                type="button"
              >
                {t("aiResume")}
              </button>
              <button
                className="flex-1 rounded-[4px] px-2 py-1 font-medium text-[11px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                disabled={isMutating || cancelling}
                onClick={handleCancel}
                type="button"
              >
                {t("cancel")}
              </button>
            </>
          ) : (
            <button
              className="flex-1 rounded-[4px] px-2 py-1 font-medium text-[11px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
              disabled={isMutating || cancelling}
              onClick={handlePause}
              type="button"
            >
              {t("aiPause")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
