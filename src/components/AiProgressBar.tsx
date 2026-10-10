import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { aiActions, rebuildAiIndex } from "@/actions/ai";
import { openExternalLink } from "@/actions/shell";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { AiStatus } from "@/types/photo";

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
  readiness?: Pick<
    AiStatus,
    "rebuildRequired" | "vectorCompatibility" | "vectorBuildState"
  > | null;
  repairReason?: string;
  total: number;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this component coordinates existing UI state and rendering branches
export function AiProgressBar({
  disabled = false,
  migrationOnly = false,
}: {
  disabled?: boolean;
  migrationOnly?: boolean;
}) {
  const { t } = useTranslation();
  const [progress, setProgress] = useState<AiProgress | null>(null);
  const [isMutating, setIsMutating] = useState(false);
  const [isRebuilding, setIsRebuilding] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [rebuildError, setRebuildError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const mutationRef = useRef(false);
  const pollingRef = useRef(false);

  const fetchProgress = useCallback(async () => {
    try {
      const [result, readiness] = await Promise.all([
        aiActions.getProgress(),
        aiActions.getStatus().catch(() => null),
      ]);
      return { ...result, readiness } as AiProgress;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    fetchProgress().then((p) => {
      if (!disposed && p) {
        setProgress(p);
      }
    });

    return () => {
      disposed = true;
    };
  }, [fetchProgress]);

  // Poll while active (fast: 500ms)
  useEffect(() => {
    if (!progress?.isActive || pollingRef.current) {
      return;
    }

    pollingRef.current = true;
    let timer: ReturnType<typeof setTimeout>;
    let disposed = false;

    const poll = async () => {
      const p = await fetchProgress();
      if (disposed) {
        return;
      }
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
      disposed = true;
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
    let disposed = false;

    const poll = async () => {
      const p = await fetchProgress();
      if (disposed) {
        return;
      }
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
      disposed = true;
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
    } else {
      setLastError(null);
    }
  }, [progress, t]);

  async function runProgressMutation(action: () => Promise<unknown>) {
    if (mutationRef.current || disabled) {
      return;
    }
    mutationRef.current = true;
    setIsMutating(true);
    setMutationError(null);
    try {
      const result = await action();
      if (
        result &&
        typeof result === "object" &&
        (("busy" in result && result.busy === true) ||
          ("started" in result && result.started === false) ||
          ("resumed" in result && result.resumed === false))
      ) {
        setMutationError(
          t("busy" in result && result.busy ? "aiIndexBusy" : "aiInitFailed")
        );
      }
      const p = await fetchProgress();
      if (p) {
        setProgress(p);
      } else {
        setProgress(null);
      }
    } catch {
      setLastError(t("aiInitFailed"));
    } finally {
      mutationRef.current = false;
      setIsMutating(false);
    }
  }

  async function handleStart() {
    if (disabled) {
      return;
    }
    setLastError(null);
    await runProgressMutation(() => aiActions.start());
  }

  async function handlePause() {
    await runProgressMutation(() => aiActions.pause());
  }

  async function handleResume() {
    setLastError(null);
    await runProgressMutation(() => aiActions.resume());
  }

  async function handleCancel() {
    await runProgressMutation(() => aiActions.cancel());
  }

  const mutationNotice =
    mutationError || rebuildError ? (
      <p className="mt-2 break-words text-[12px] text-danger" role="alert">
        {mutationError || rebuildError}
      </p>
    ) : null;

  async function handleRebuild() {
    if (
      disabled ||
      mutationRef.current ||
      progress?.isActive ||
      (progress?.controlState && progress.controlState !== "idle")
    ) {
      return;
    }
    setLastError(null);
    setRebuildError(null);
    setIsRebuilding(true);
    try {
      await runProgressMutation(async () => {
        try {
          const result = await rebuildAiIndex();
          if (!result.success) {
            setRebuildError(
              t(result.busy ? "aiIndexBusy" : "aiIndexRebuildFailed")
            );
          }
        } catch {
          setRebuildError(t("aiIndexRebuildFailed"));
        }
      });
    } finally {
      setIsRebuilding(false);
    }
  }

  const idleRebuildError =
    rebuildError &&
    (!progress?.controlState || progress.controlState === "idle");
  if (
    isRebuilding ||
    (!progress?.isActive &&
      (progress?.readiness?.rebuildRequired || idleRebuildError))
  ) {
    let description = "aiIndexRebuildDescription";
    if (isRebuilding) {
      description = "aiIndexRebuildPreparing";
    } else if (rebuildError) {
      description = "aiIndexRebuildRetryHint";
    }
    return (
      <div
        aria-busy={isRebuilding}
        className="min-w-0 rounded-[8px] border border-amber-500/30 bg-amber-500/10 p-3 min-[480px]:p-4"
        role={rebuildError ? "alert" : "status"}
      >
        <p className="break-words font-medium text-[14px] text-amber-700 dark:text-amber-300">
          {isRebuilding
            ? t("aiRepairingIndex")
            : rebuildError || t("aiIndexRebuildRequired")}
        </p>
        <p className="mt-2 break-words text-[12px] text-muted-foreground leading-relaxed">
          {t(description)}
        </p>
        <Button
          className="mt-3 h-auto min-h-8 max-w-full whitespace-normal px-3 py-1.5"
          disabled={
            disabled ||
            isMutating ||
            (progress?.controlState !== undefined &&
              progress.controlState !== "idle")
          }
          onClick={handleRebuild}
          size="lg"
          type="button"
        >
          {t(isRebuilding ? "aiRepairingIndex" : "aiRebuildIndex")}
        </Button>
      </div>
    );
  }

  // Optional compact notices expose only incompatible-index migration.
  if (migrationOnly) {
    return mutationNotice;
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
      <div className="min-w-0 rounded-[8px] border border-danger/30 bg-danger/5 p-3 min-[480px]:p-4">
        <p className="break-words font-medium text-[14px] text-danger">
          {t(progress?.phase === "tag-error" ? "aiTagsFailed" : "aiInitFailed")}
        </p>
        {mutationNotice}

        {isNetworkError ? (
          <div className="mt-3 space-y-3">
            <p className="text-[12px] text-muted-foreground leading-relaxed">
              {t("aiNetworkErrorHint")}
            </p>
            <div className="min-w-0 rounded-[6px] border border-border bg-card p-3">
              <p className="mb-2 text-[12px] text-muted-foreground">
                {t("aiMirrorRecommendation")}
              </p>
              <Button
                className="h-auto min-h-8 max-w-full whitespace-normal px-3 py-1.5"
                onClick={async () => {
                  try {
                    await openExternalLink("https://hf-mirror.com");
                  } catch {
                    // The shell action reports its own failure to the caller.
                  }
                }}
                size="lg"
                type="button"
                variant="outline"
              >
                {t("aiOpenMirrorSite")}
              </Button>
            </div>
          </div>
        ) : (
          <p className="mt-2 text-[12px] text-muted-foreground leading-relaxed [overflow-wrap:anywhere]">
            {t("aiMirrorHint")}
            <code className="mx-0.5 rounded-[4px] bg-card px-1 text-[12px] text-muted-foreground">
              HF_MIRROR=hf-mirror.com
            </code>
          </p>
        )}

        <Button
          className="mt-3 h-auto min-h-8 max-w-full whitespace-normal px-3 py-1.5"
          disabled={disabled || isMutating}
          onClick={handleStart}
          size="lg"
          type="button"
        >
          {t("aiRetry")}
        </Button>
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
      <div className="min-w-0 rounded-[8px] border border-border bg-secondary p-3 min-[480px]:p-4">
        {mutationNotice}
        <Button
          className="h-auto min-h-8 max-w-full whitespace-normal px-3 py-1.5"
          disabled={disabled || isMutating || !progress}
          onClick={handleStart}
          size="lg"
          type="button"
        >
          {t("aiStartIndex")}
        </Button>
      </div>
    );
  }

  // Complete state: show re-index button for newly added photos
  if (!progress.isActive && progress.phase === "complete") {
    const incompleteBuild = progress.readiness?.vectorBuildState === "building";
    const completePercent =
      progress.total > 0
        ? Math.round((progress.processed / progress.total) * 100)
        : 100;
    return (
      <div className="min-w-0 rounded-[8px] border border-border bg-secondary p-3 min-[480px]:p-4">
        {mutationNotice}
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <span className="min-w-0 break-words font-medium text-[14px] text-foreground">
            {incompleteBuild
              ? t("aiIndexBuildIncomplete")
              : t("aiIndexComplete", {
                  processed: progress.processed,
                  total: progress.total,
                })}
          </span>
          <span className="font-medium text-[12px] text-primary">
            {!incompleteBuild && `${completePercent}%`}
          </span>
        </div>
        <Button
          className="mt-3 h-auto min-h-8 max-w-full whitespace-normal px-3 py-1.5"
          disabled={disabled || isMutating}
          onClick={handleStart}
          size="lg"
          type="button"
          variant="outline"
        >
          {t("aiIndexNewPhotos")}
        </Button>
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
        ? t("aiLoadingEmbeddingIndeterminate")
        : t("aiLoadingEmbedding", { percent: progress.downloadPercent });
  } else if (progress.phase === "complete") {
    phaseLabel = t("aiComplete");
  }

  return (
    <div className="min-w-0 rounded-[8px] border border-border bg-secondary p-3 min-[480px]:p-4">
      {mutationNotice}
      {progress.repairReason && (
        <p className="mb-3 rounded-[6px] bg-primary/10 px-3 py-2 text-[12px] text-primary leading-relaxed">
          {t("aiRepairingIndex")}
        </p>
      )}
      <div className="mb-3 flex min-w-0 flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 break-words font-medium text-[14px] text-foreground">
          {phaseLabel}
        </span>
        <span className="font-medium text-[12px] text-primary">{pct}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-foreground/10">
        <div
          className="h-full rounded-full bg-primary transition-all duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      {progress.currentFile && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className="mt-2 block w-full min-w-0 truncate text-left text-[12px] text-muted-foreground"
              type="button"
            >
              {progress.currentFile}
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-[min(32rem,90dvw)] break-all">
            {progress.currentFile}
          </TooltipContent>
        </Tooltip>
      )}
      {progress.phase === "embedding" && (
        <div className="mt-3 flex min-w-0 flex-wrap gap-2">
          {paused ? (
            <>
              <Button
                className="h-auto min-h-8 max-w-full whitespace-normal px-3 py-1.5"
                disabled={
                  isMutating || cancelling || controlState === "pausing"
                }
                onClick={handleResume}
                size="lg"
                type="button"
              >
                {t("aiResume")}
              </Button>
              <Button
                className="h-auto min-h-8 max-w-full whitespace-normal px-3 py-1.5"
                disabled={isMutating || cancelling}
                onClick={handleCancel}
                size="lg"
                type="button"
                variant="outline"
              >
                {t("cancel")}
              </Button>
            </>
          ) : (
            <Button
              className="h-auto min-h-8 max-w-full whitespace-normal px-3 py-1.5"
              disabled={isMutating || cancelling}
              onClick={handlePause}
              size="lg"
              type="button"
              variant="outline"
            >
              {t("aiPause")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
