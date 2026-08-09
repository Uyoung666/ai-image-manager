// biome-ignore-all lint/a11y/noStaticElementInteractions: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/a11y/noNoninteractiveElementInteractions: scoped component lint cleanup preserves existing UI behavior
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  HelpCircle,
  Link,
  Swords,
  Undo2,
  Unlink,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ZoomableImage,
  type ZoomableImageHandle,
  type ZoomState,
} from "@/components/ZoomableImage";
import { useChromeVisibility } from "@/hooks/use-chrome-visibility";
import { useDebouncedFlag } from "@/hooks/use-debounced-flag";
import { ipc } from "@/ipc/manager";
import type { SessionSummary } from "@/routes/cull.$sessionId";

// ── Types ──

interface PhotoInfo {
  duelPreviewPath?: string | null;
  fileDate: number | null;
  filename: string;
  fileSize: number;
  format: string;
  height: number;
  id: number;
  isFavorite: boolean | null;
  isIndexed: boolean;
  path: string;
  thumbnailPath: string | null;
  width: number;
}

interface PairItem {
  comparisons: number;
  losses: number;
  photo: PhotoInfo;
  rating: number;
  sessionPhotoId: number;
  wins: number;
}

interface ExifData {
  advanced?: {
    capture?: { captureMode?: string | null };
    processing?: { inCameraLook?: string | null };
  } | null;
  aperture: number | null;
  cameraMake: string | null;
  cameraModel: string | null;
  dateTaken: number | null;
  focalLength: string | null;
  iso: number | null;
  lensModel: string | null;
  shutterSpeed: string | null;
}

interface PairResult {
  done: boolean;
  pair?: PairItem[];
  phase?: string;
  reason?: string;
  stats: {
    total: number;
    completed: number;
    remaining: number;
    ready?: number;
  };
}

interface CullDuelProps {
  /** Called after every mutation so the parent can invalidate its session query */
  onMutationSuccess: () => void;
  session: Pick<
    SessionSummary,
    "id" | "mode" | "pkMode" | "totalPhotos" | "completedComparisons" | "status"
  >;
}

const FATIGUE_THRESHOLD = 100;
const MAX_FATIGUE_REMINDERS = 2;

function formatExifDate(ts: number | null): string {
  if (!ts) {
    return "";
  }
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Component ──

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: duel state and keyboard workflow are intentionally kept together
export function CullDuel({ session, onMutationSuccess }: CullDuelProps) {
  const { t } = useTranslation();
  const requestedPreviewIdsRef = useRef(new Set<number>());
  const [previewResolutions, setPreviewResolutions] = useState<
    Record<number, { path: string | null; useOriginal: boolean }>
  >({});

  // React 19: mark pair-switch state as non-urgent transition
  const [isTransitioning, startTransition] = useTransition();

  // Increment to trigger a fresh getNextPair IPC call
  const [pairFetchId, setPairFetchId] = useState(0);

  // EXIF hover overlay visibility per side — React state ensures clean transition start
  const [showExifLeft, setShowExifLeft] = useState(false);
  const [showExifRight, setShowExifRight] = useState(false);

  // Accumulates broken-photo IDs across the session; never cleared on
  // successful mutations because a broken photo stays broken. Sent to
  // backend as excludeIds to prevent infinite retry loops.
  const erroredPhotosRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    erroredPhotosRef.current.clear();
  }, []);

  // keepPreviousData holds old pair visible while next pair fetches
  const pairQuery = useQuery({
    queryKey: ["cull", "pair", session.id, pairFetchId],
    queryFn: async () => {
      const excludeSessionPhotoIds = Array.from(erroredPhotosRef.current);
      const result = (await ipc.client.cull.getNextPair({
        sessionId: session.id,
        excludeSessionPhotoIds:
          excludeSessionPhotoIds.length > 0
            ? excludeSessionPhotoIds
            : undefined,
      })) as PairResult;
      return result;
    },
    placeholderData: keepPreviousData,
    // pairFetchId changes force a fresh fetch each time
    staleTime: 0,
    gcTime: 30_000,
  });

  const pairData = pairQuery.data;
  const done = pairData?.done ?? false;
  const pair = pairData?.pair;
  const stats = pairData?.stats ?? null;
  const isSessionCompleted = done || session.status === "completed";

  // 懒触发生成对比预览：直接更新本地资源，避免生成完成后刷新整个 PK 页面。
  useEffect(() => {
    if (!pair) {
      return;
    }
    for (const item of pair) {
      if (
        !(
          item.photo.duelPreviewPath ||
          requestedPreviewIdsRef.current.has(item.photo.id)
        )
      ) {
        const photoId = item.photo.id;
        requestedPreviewIdsRef.current.add(photoId);
        ipc.client.cull
          .ensureDuelPreview({ photoId })
          .then((result) => {
            const resolved = result as {
              duelPreviewPath: string | null;
              strategy?: "use_original";
            };
            setPreviewResolutions((current) => ({
              ...current,
              [photoId]: {
                path: resolved.duelPreviewPath,
                useOriginal: resolved.strategy === "use_original",
              },
            }));
          })
          .catch(() => {
            requestedPreviewIdsRef.current.delete(photoId);
          });
      }
    }
  }, [pair]);

  // useMutation.isPending drives button locking — no manual submittingRef

  const submitMutation = useMutation({
    mutationFn: async (params: {
      winnerId: number;
      loserId: number;
      isDraw?: boolean;
    }) => {
      return (await ipc.client.cull.submitComparison({
        sessionId: session.id,
        ...params,
      })) as unknown;
    },
    onSuccess: () => {
      onMutationSuccess();
      startTransition(() => {
        setPairFetchId((n) => n + 1);
        setShowExifLeft(false);
        setShowExifRight(false);
      });
    },
    onError: (err) => {
      console.error("[submitComparison] failed:", err);
      toast.error(t("cullActionFailed"));
    },
  });

  const skipMutation = useMutation({
    mutationFn: async (params: { photoAId: number; photoBId: number }) => {
      return (await ipc.client.cull.recordSkip({
        sessionId: session.id,
        ...params,
      })) as unknown;
    },
    onSuccess: () => {
      onMutationSuccess();
      startTransition(() => {
        setPairFetchId((n) => n + 1);
        setShowExifLeft(false);
        setShowExifRight(false);
      });
    },
    onError: (err) => {
      console.error("[recordSkip] failed:", err);
      toast.error(t("cullActionFailed"));
    },
  });

  const undoMutation = useMutation({
    mutationFn: async () => {
      return (await ipc.client.cull.undoLastAction({
        sessionId: session.id,
      })) as unknown;
    },
    onSuccess: () => {
      onMutationSuccess();
      startTransition(() => {
        setPairFetchId((n) => n + 1);
        setShowExifLeft(false);
        setShowExifRight(false);
      });
    },
    onError: (err) => {
      console.error("[undoLastAction] failed:", err);
      toast.error(t("cullActionFailed"));
    },
  });

  const completeMutation = useMutation({
    mutationFn: async () => {
      return (await ipc.client.cull.completeSession({
        sessionId: session.id,
      })) as unknown;
    },
    onSuccess: () => {
      onMutationSuccess();
    },
    onError: (err) => {
      console.error("[completeSession] failed:", err);
      toast.error(t("cullActionFailed"));
    },
  });

  // Unified "is submitting" gate — disables all action buttons
  const isSubmitting =
    submitMutation.isPending ||
    skipMutation.isPending ||
    undoMutation.isPending ||
    completeMutation.isPending ||
    pairQuery.isFetching ||
    isTransitioning;

  // On image load failure: track the broken ID in erroredPhotosRef,
  // then skip to next pair without submitting a comparison.
  const handleImageError = useCallback(
    (side: "left" | "right") => {
      const current = pairQuery.data?.pair;
      if (!current) {
        return;
      }

      const errored = side === "left" ? current[0] : current[1];
      erroredPhotosRef.current.add(errored.sessionPhotoId);

      toast.warning(t("cullPhotoUnavailable"), { duration: 2500 });

      // Skip without submitting — server-side progress stays correct
      startTransition(() => {
        setPairFetchId((n) => n + 1);
        setShowExifLeft(false);
        setShowExifRight(false);
      });
    },
    [pairQuery.data?.pair, t]
  );
  const handleLeftImageError = useCallback(
    () => handleImageError("left"),
    [handleImageError]
  );
  const handleRightImageError = useCallback(
    () => handleImageError("right"),
    [handleImageError]
  );

  // Zoom sync between left/right images
  const [syncZoom, setSyncZoom] = useState(true);
  const leftZoomRef = useRef<ZoomableImageHandle | null>(null);
  const rightZoomRef = useRef<ZoomableImageHandle | null>(null);

  const sameRatio = pair
    ? Math.abs(
        pair[0].photo.width / pair[0].photo.height -
          pair[1].photo.width / pair[1].photo.height
      ) < 0.02
    : false;

  const effectiveSync = syncZoom && sameRatio;

  const handleLeftZoomSync = useCallback(
    (state: ZoomState) => {
      if (!effectiveSync) {
        return;
      }
      rightZoomRef.current?.applySync(state);
    },
    [effectiveSync]
  );
  const handleRightZoomSync = useCallback(
    (state: ZoomState) => {
      if (!effectiveSync) {
        return;
      }
      leftZoomRef.current?.applySync(state);
    },
    [effectiveSync]
  );

  // Dialogs, fatigue, EXIF
  const [exifLeft, setExifLeft] = useState<ExifData | null>(null);
  const [exifRight, setExifRight] = useState<ExifData | null>(null);
  const [finishConfirmOpen, setFinishConfirmOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [fatigueOpen, setFatigueOpen] = useState(false);
  const [lastReason, setLastReason] = useState<string | null>(null);

  const shortcutsOpenRef = useRef(false);
  const finishConfirmOpenRef = useRef(false);
  finishConfirmOpenRef.current = finishConfirmOpen;
  const fatigueOpenRef = useRef(false);

  // Chrome auto-hide: toolbars fade out after 2s of mouse inactivity
  const chrome = useChromeVisibility({
    forceVisible: finishConfirmOpen || fatigueOpen,
  });

  const comparisonCountRef = useRef(0);
  const fatigueRemindersRef = useRef(0);

  useEffect(() => {
    comparisonCountRef.current = 0;
    fatigueRemindersRef.current = 0;
  }, []);

  // Load EXIF when pair changes
  useEffect(() => {
    if (!pair) {
      setExifLeft(null);
      setExifRight(null);
      return;
    }
    const [a, b] = pair;
    let cancelled = false;

    async function load() {
      try {
        const [ea, eb] = await Promise.all([
          ipc.client.photos.getPhotoExif({ id: a.photo.id }).catch(() => null),
          ipc.client.photos.getPhotoExif({ id: b.photo.id }).catch(() => null),
        ]);
        if (cancelled) {
          return;
        }
        setExifLeft(ea as ExifData | null);
        setExifRight(eb as ExifData | null);
        setLastReason(pairData?.reason ?? null);

        // Fatigue check
        comparisonCountRef.current++;
        if (
          fatigueRemindersRef.current < MAX_FATIGUE_REMINDERS &&
          comparisonCountRef.current > 0 &&
          comparisonCountRef.current % FATIGUE_THRESHOLD === 0
        ) {
          fatigueRemindersRef.current++;
          setFatigueOpen(true);
        }
      } catch {
        /* EXIF is non-critical */
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [pair, pairData?.reason]);

  // Keyboard shortcuts — pair data via ref to avoid stale closures.
  // Mutation functions are stable references from useMutation.
  const pairRef = useRef(pair);
  pairRef.current = pair;

  useEffect(() => {
    shortcutsOpenRef.current = shortcutsOpen;
  }, [shortcutsOpen]);
  useEffect(() => {
    fatigueOpenRef.current = fatigueOpen;
  }, [fatigueOpen]);

  useEffect(() => {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: shortcut handler preserves the existing keyboard workflow
    function onKey(e: KeyboardEvent) {
      // ? 键始终处理（切换面板），不受面板打开状态影响
      if (e.key === "?") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setShortcutsOpen((prev) => {
          shortcutsOpenRef.current = !prev;
          return !prev;
        });
        return;
      }
      if (fatigueOpenRef.current || finishConfirmOpenRef.current) {
        return;
      }
      if (isSessionCompleted) {
        return;
      }
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      const current = pairRef.current;

      if (e.key === "ArrowLeft" && current) {
        e.preventDefault();
        if (isSubmitting) {
          return;
        }
        submitMutation.mutate({
          winnerId: current[0].sessionPhotoId,
          loserId: current[1].sessionPhotoId,
        });
      } else if (e.key === "ArrowRight" && current) {
        e.preventDefault();
        if (isSubmitting) {
          return;
        }
        submitMutation.mutate({
          winnerId: current[1].sessionPhotoId,
          loserId: current[0].sessionPhotoId,
        });
      } else if ((e.key === " " || e.key === "ArrowDown") && current) {
        e.preventDefault();
        if (isSubmitting) {
          return;
        }
        skipMutation.mutate({
          photoAId: current[0].sessionPhotoId,
          photoBId: current[1].sessionPhotoId,
        });
      } else if (e.key === "z" && e.ctrlKey) {
        e.preventDefault();
        if (isSubmitting) {
          return;
        }
        undoMutation.mutate();
      } else if (e.key === "d" && !e.ctrlKey && !e.metaKey && current) {
        e.preventDefault();
        if (isSubmitting) {
          return;
        }
        submitMutation.mutate({
          winnerId: current[0].sessionPhotoId,
          loserId: current[1].sessionPhotoId,
          isDraw: true,
        });
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [
    isSessionCompleted,
    isSubmitting,
    submitMutation,
    skipMutation,
    undoMutation,
  ]);

  // showTransition 即时拦截交互，showSpinner 经 150ms 防抖避免频闪
  const isFetchingNext = pairQuery.isFetching && !pairQuery.isLoading;
  const showTransition = isTransitioning || isFetchingNext;
  const showSpinner = useDebouncedFlag(showTransition, 150);

  // Done state
  if (isSessionCompleted && !pairQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <Swords className="mx-auto h-12 w-12 text-success/50" />
          <p className="mt-4 font-medium text-[16px] text-foreground">
            {t("cullAllComparisonsComplete")}
          </p>
          {stats && (
            <p className="mt-2 text-[13px] text-muted-foreground/70">
              {t("cullPhotoCount", { count: stats.total })} ·{" "}
              {t("cullPkCount", { count: stats.completed })}
            </p>
          )}
        </div>
      </div>
    );
  }

  // Loading (first fetch only)
  if (pairQuery.isLoading && !pairQuery.data) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner size="xl" />
      </div>
    );
  }

  if (pairQuery.isError && !pairQuery.data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-[13px] text-destructive">{t("cullActionFailed")}</p>
        <button
          className="rounded-[6px] bg-primary px-3 py-1.5 text-[12px] text-primary-foreground"
          onClick={() => pairQuery.refetch()}
          type="button"
        >
          {t("retry")}
        </button>
      </div>
    );
  }

  if (!pair) {
    return null;
  }

  const [left, right] = pair;

  function renderExifRow(label: string, value: string | null | undefined) {
    if (!value) {
      return null;
    }
    return (
      <span className="text-[10px] text-white/50">
        {label}: {value}
      </span>
    );
  }

  function renderExifInfo(exif: ExifData | null, photo: PhotoInfo) {
    return (
      <div className="mt-0 flex max-w-[400px] flex-wrap items-center justify-center gap-x-3 gap-y-0.5">
        {exif ? (
          <>
            {renderExifRow(t("cullFileName"), photo.filename)}
            {renderExifRow(t("cullDateTaken"), formatExifDate(exif.dateTaken))}
            {renderExifRow(
              t("cullDimensions"),
              `${photo.width}×${photo.height}`
            )}
            {renderExifRow(t("cullSize"), formatFileSize(photo.fileSize))}
            {renderExifRow(
              t("focalLength"),
              exif.focalLength ? `${exif.focalLength}mm` : null
            )}
            {renderExifRow(t("shutter"), exif.shutterSpeed)}
            {renderExifRow(
              t("iso"),
              exif.iso == null ? null : String(exif.iso)
            )}
            {renderExifRow(
              t("aperture"),
              exif.aperture == null ? null : `f/${exif.aperture}`
            )}
            {renderExifRow(
              t("metadataCaptureMode"),
              exif.advanced?.capture?.captureMode
            )}
            {renderExifRow(
              t("metadataInCameraLook"),
              exif.advanced?.processing?.inCameraLook
            )}
          </>
        ) : (
          <span className="text-[10px] text-white/30">{t("cullNoExif")}</span>
        )}
      </div>
    );
  }

  return (
    <div
      className="relative flex h-full min-h-0 min-w-0 select-none flex-col overflow-hidden bg-black"
      {...chrome}
    >
      {/* Top bar — glass overlay */}
      <div
        className={`flex shrink-0 items-center justify-between gap-2 overflow-x-auto border-white/[0.06] border-b bg-background/70 px-3 py-1.5 backdrop-blur-xl transition-opacity duration-500 sm:px-6 sm:py-2 ${
          chrome.visible ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        <span className="min-w-[6rem] flex-1 truncate whitespace-nowrap text-[11px] text-muted-foreground/70">
          {(() => {
            const pkCount = stats?.completed ?? session.completedComparisons;
            const totalPhotos = stats?.total ?? session.totalPhotos;
            // Force 100% when completed; bail if all photos cascade-deleted
            if (isSessionCompleted) {
              return t("cullProgressDetail", {
                pkCount,
                totalWork: pkCount,
                pct: 100,
                count: 0,
              });
            }
            if (totalPhotos <= 0) {
              return t("cullProgressDetail", {
                pkCount,
                totalWork: 0,
                pct: 0,
                count: 0,
              });
            }
            let minC = 8;
            let recompareBudget = Math.ceil(totalPhotos * 0.15);
            if (session.pkMode === "quick") {
              minC = 5;
              recompareBudget = 0;
            } else if (session.pkMode === "fine") {
              minC = 12;
              recompareBudget = Math.ceil(totalPhotos * 0.3);
            }
            const totalWork = Math.max(
              1,
              Math.ceil((totalPhotos * minC) / 2) + recompareBudget
            );
            // Cap at 99 while active — only the completed guard pushes to 100
            const pct = Math.min(99, Math.round((pkCount / totalWork) * 100));
            const remainingPks = Math.max(0, totalWork - pkCount);
            return t("cullProgressDetail", {
              pkCount,
              totalWork,
              pct,
              count: remainingPks,
            });
          })()}
        </span>
        <span className="shrink-0 whitespace-nowrap rounded-[3px] bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {(() => {
            const labels: Record<string, string> = {
              quick: t("cullPkModeQuick"),
              standard: t("cullPkModeStandard"),
              fine: t("cullPkModeFine"),
            };
            return (
              labels[session.pkMode ?? "standard"] ?? t("cullPkModeStandard")
            );
          })()}
        </span>
        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          {sameRatio && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  aria-label={t("cullSyncZoomDesc")}
                  className="flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => {
                    setSyncZoom((v) => !v);
                  }}
                  type="button"
                >
                  {syncZoom ? (
                    <Link className="h-3 w-3" />
                  ) : (
                    <Unlink className="h-3 w-3" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent>{t("cullSyncZoomDesc")}</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                aria-label={t("keyboardHelpTitle")}
                className="flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => {
                  shortcutsOpenRef.current = true;
                  setShortcutsOpen(true);
                }}
                type="button"
              >
                <HelpCircle className="h-3 w-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{t("keyboardHelpTitle")}</TooltipContent>
          </Tooltip>
          <button
            className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[4px] px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
            disabled={isSubmitting}
            onClick={() => setFinishConfirmOpen(true)}
            type="button"
          >
            <CheckCircle2 className="h-3 w-3" />
            {t("cullFinish")}
          </button>
          <button
            className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[4px] px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
            disabled={isSubmitting}
            onClick={() => undoMutation.mutate()}
            type="button"
          >
            <Undo2 className="h-3 w-3" />
            {t("cullUndo")} (Ctrl+Z)
          </button>
        </div>
      </div>

      {/* Photo pair — fade-in on swap */}
      <div
        className={`relative flex min-h-0 min-w-0 flex-1 animate-photo-fade-in overflow-hidden ${
          showTransition ? "pointer-events-none" : ""
        }`}
        key={pairFetchId}
      >
        {/* Left photo */}
        <div
          className="relative flex min-h-0 min-w-0 basis-1/2 flex-col items-center justify-center overflow-hidden"
          onMouseEnter={() => setShowExifLeft(true)}
          onMouseLeave={() => setShowExifLeft(false)}
        >
          <div
            className="min-h-0 w-full min-w-0 flex-1 overflow-hidden"
            data-zoom
          >
            <ZoomableImage
              alt={left.photo.filename}
              duelPreviewPath={
                left.photo.duelPreviewPath ??
                previewResolutions[left.photo.id]?.path
              }
              enableOriginalOnZoom={true}
              enableProgressiveLoading={true}
              filePath={left.photo.path}
              key={`L-${pairFetchId}`}
              onError={handleLeftImageError}
              onSync={handleLeftZoomSync}
              ref={leftZoomRef}
              thumbnailPath={left.photo.thumbnailPath}
              useOriginalAsPreview={
                previewResolutions[left.photo.id]?.useOriginal ?? false
              }
            />
          </div>

          {/* EXIF hover overlay — fades in on hover */}
          <div
            className={`pointer-events-none absolute right-0 bottom-0 left-0 z-10 transition-opacity duration-200 ${
              showExifLeft ? "opacity-100" : "opacity-0"
            }`}
          >
            <div className="mx-auto max-h-full max-w-[400px] overflow-hidden px-2 pb-12 sm:px-4 sm:pb-14">
              <div className="rounded-[8px] bg-black/75 px-3 py-1.5">
                {renderExifInfo(exifLeft, left.photo)}
                <div className="mt-0.5 flex items-center justify-center gap-3 text-[10px] text-white/50">
                  <span>
                    {t("cullRating")}: {left.rating}
                  </span>
                  <span>
                    {t("cullWins")}: {left.wins}
                  </span>
                  <span>
                    {t("cullLosses")}: {left.losses}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Pick button — dedicated glass button at bottom */}
          <div className="absolute right-0 bottom-2 left-0 z-10 flex justify-center sm:bottom-3">
            <button
              className="max-w-[calc(100%-1rem)] truncate rounded-full border border-white/20 bg-black/40 px-3 py-1.5 text-[12px] text-white/90 backdrop-blur-md transition-all hover:border-white/35 hover:bg-black/60 hover:text-white hover:shadow-[0_0_16px_-4px_rgba(0,0,0,0.3)] active:scale-[0.96] disabled:opacity-30 sm:px-4"
              disabled={isSubmitting}
              onClick={(e) => {
                e.stopPropagation();
                if (isSubmitting) {
                  return;
                }
                submitMutation.mutate({
                  winnerId: left.sessionPhotoId,
                  loserId: right.sessionPhotoId,
                });
              }}
              type="button"
            >
              ← {t("cullPickLeft")}
            </button>
          </div>
        </div>

        {/* VS divider — vertical gradient + glass badge */}
        <div className="pointer-events-none absolute top-0 right-0 bottom-0 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center">
          {/* Top gradient line */}
          <div className="w-px flex-1 bg-gradient-to-b from-transparent via-white/[0.04] to-white/[0.10]" />
          {/* VS badge with halo */}
          <div className="relative flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.10] bg-black/50 shadow-[0_0_20px_-4px_rgba(255,255,255,0.10)] backdrop-blur-xl sm:h-10 sm:w-10">
            <span className="select-none font-semibold text-[11px] text-white/50 tracking-wider">
              VS
            </span>
          </div>
          {/* Bottom gradient line */}
          <div className="w-px flex-1 bg-gradient-to-b from-white/[0.10] via-white/[0.04] to-transparent" />
        </div>

        {/* Right photo */}
        <div
          className="relative flex min-h-0 min-w-0 basis-1/2 flex-col items-center justify-center overflow-hidden"
          onMouseEnter={() => setShowExifRight(true)}
          onMouseLeave={() => setShowExifRight(false)}
        >
          <div
            className="min-h-0 w-full min-w-0 flex-1 overflow-hidden"
            data-zoom
          >
            <ZoomableImage
              alt={right.photo.filename}
              duelPreviewPath={
                right.photo.duelPreviewPath ??
                previewResolutions[right.photo.id]?.path
              }
              enableOriginalOnZoom={true}
              enableProgressiveLoading={true}
              filePath={right.photo.path}
              key={`R-${pairFetchId}`}
              onError={handleRightImageError}
              onSync={handleRightZoomSync}
              ref={rightZoomRef}
              thumbnailPath={right.photo.thumbnailPath}
              useOriginalAsPreview={
                previewResolutions[right.photo.id]?.useOriginal ?? false
              }
            />
          </div>

          {/* EXIF hover overlay — fades in on hover */}
          <div
            className={`pointer-events-none absolute right-0 bottom-0 left-0 z-10 transition-opacity duration-200 ${
              showExifRight ? "opacity-100" : "opacity-0"
            }`}
          >
            <div className="mx-auto max-h-full max-w-[400px] overflow-hidden px-2 pb-12 sm:px-4 sm:pb-14">
              <div className="rounded-[8px] bg-black/75 px-3 py-1.5">
                {renderExifInfo(exifRight, right.photo)}
                <div className="mt-0.5 flex items-center justify-center gap-3 text-[10px] text-white/50">
                  <span>
                    {t("cullRating")}: {right.rating}
                  </span>
                  <span>
                    {t("cullWins")}: {right.wins}
                  </span>
                  <span>
                    {t("cullLosses")}: {right.losses}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Pick button — dedicated glass button at bottom */}
          <div className="absolute right-0 bottom-2 left-0 z-10 flex justify-center sm:bottom-3">
            <button
              className="max-w-[calc(100%-1rem)] truncate rounded-full border border-white/20 bg-black/40 px-3 py-1.5 text-[12px] text-white/90 backdrop-blur-md transition-all hover:border-white/35 hover:bg-black/60 hover:text-white hover:shadow-[0_0_16px_-4px_rgba(0,0,0,0.3)] active:scale-[0.96] disabled:opacity-30 sm:px-4"
              disabled={isSubmitting}
              onClick={(e) => {
                e.stopPropagation();
                if (isSubmitting) {
                  return;
                }
                submitMutation.mutate({
                  winnerId: right.sessionPhotoId,
                  loserId: left.sessionPhotoId,
                });
              }}
              type="button"
            >
              {t("cullPickRight")} →
            </button>
          </div>
        </div>
      </div>

      {/* 防抖 Spinner — 仅过渡持续 > 150ms 时挂载 */}
      {showSpinner && (
        <div className="pointer-events-none absolute top-1/2 left-1/2 z-20 -translate-x-1/2 -translate-y-1/2">
          <LoadingSpinner size="md" variant="overlay" />
        </div>
      )}

      {/* Bottom bar — glass overlay */}
      <div
        className={`flex shrink-0 items-center justify-start gap-2 overflow-x-auto border-white/[0.06] border-t bg-background/70 px-3 py-2 backdrop-blur-xl transition-opacity duration-500 sm:justify-center sm:gap-4 sm:px-6 sm:py-3 ${
          chrome.visible ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        <button
          className="shrink-0 whitespace-nowrap rounded-[6px] border border-border bg-secondary px-3 py-1.5 text-[12px] text-muted-foreground transition-all hover:border-foreground/20 hover:bg-secondary/80 hover:text-foreground disabled:opacity-40 sm:px-4"
          disabled={isSubmitting}
          onClick={() =>
            skipMutation.mutate({
              photoAId: left.sessionPhotoId,
              photoBId: right.sessionPhotoId,
            })
          }
          type="button"
        >
          {t("cullSkip")} (Space)
        </button>
        <button
          className="shrink-0 whitespace-nowrap rounded-[6px] border border-border bg-secondary px-3 py-1.5 text-[12px] text-muted-foreground transition-all hover:border-foreground/20 hover:bg-secondary/80 hover:text-foreground disabled:opacity-40 sm:px-4"
          disabled={isSubmitting}
          onClick={() =>
            submitMutation.mutate({
              winnerId: left.sessionPhotoId,
              loserId: right.sessionPhotoId,
              isDraw: true,
            })
          }
          type="button"
        >
          {t("cullDraw")} (D)
        </button>
        {lastReason && (
          <span className="ml-auto min-w-0 truncate whitespace-nowrap text-[10px] text-white/30">
            {t("cullNextPairReason")}: {lastReason}
          </span>
        )}
      </div>

      {/* Finish confirm dialog */}
      {finishConfirmOpen && (
        <Dialog onOpenChange={setFinishConfirmOpen} open={finishConfirmOpen}>
          <DialogContent className="max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{t("cullFinishConfirmTitle")}</DialogTitle>
              <DialogDescription>
                {(stats?.ready ?? 0) < (stats?.total ?? session.totalPhotos)
                  ? t("cullFinishConfirmIncomplete", {
                      ready: stats?.ready ?? 0,
                      total: stats?.total ?? session.totalPhotos,
                    })
                  : t("cullFinishConfirmComplete")}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <button
                className="rounded-[6px] px-4 py-2 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
                disabled={isSubmitting}
                onClick={() => setFinishConfirmOpen(false)}
                type="button"
              >
                {t("cancel")}
              </button>
              <button
                className="rounded-[6px] bg-primary px-4 py-2 text-[12px] text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                disabled={isSubmitting}
                onClick={() => completeMutation.mutate()}
                type="button"
              >
                {t("cullFinishAndViewResults")}
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Keyboard shortcuts — glass overlay */}
      {shortcutsOpen && (
        <button
          aria-label={t("close")}
          className="absolute inset-0 z-50 flex items-center justify-center overflow-hidden bg-black/20 p-2"
          onClick={(event) => {
            if (event.target !== event.currentTarget) {
              return;
            }
            setShortcutsOpen(false);
            shortcutsOpenRef.current = false;
          }}
          type="button"
        >
          <div className="pointer-events-auto max-h-full max-w-full overflow-auto rounded-[12px] border border-white/[0.08] bg-black/60 px-4 py-3 shadow-[0_16px_48px_-12px_rgba(0,0,0,0.6)] backdrop-blur-xl sm:px-6 sm:py-4">
            <h3 className="mb-3 text-center font-medium text-[13px] text-white/80">
              {t("cullShortcuts")}
            </h3>
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12px]">
              <kbd className="rounded-[4px] border border-white/20 bg-white/10 px-2 py-0.5 text-[11px] text-white/70">
                ←
              </kbd>
              <span className="text-white/60">{t("cullPickLeft")}</span>
              <kbd className="rounded-[4px] border border-white/20 bg-white/10 px-2 py-0.5 text-[11px] text-white/70">
                →
              </kbd>
              <span className="text-white/60">{t("cullPickRight")}</span>
              <kbd className="rounded-[4px] border border-white/20 bg-white/10 px-2 py-0.5 text-[11px] text-white/70">
                Space
              </kbd>
              <span className="text-white/60">{t("cullSkip")}</span>
              <kbd className="rounded-[4px] border border-white/20 bg-white/10 px-2 py-0.5 text-[11px] text-white/70">
                D
              </kbd>
              <span className="text-white/60">{t("cullDraw")}</span>
              <kbd className="rounded-[4px] border border-white/20 bg-white/10 px-2 py-0.5 text-[11px] text-white/70">
                Ctrl+Z
              </kbd>
              <span className="text-white/60">{t("cullUndo")}</span>
              <kbd className="rounded-[4px] border border-white/20 bg-white/10 px-2 py-0.5 text-[11px] text-white/70">
                +
              </kbd>
              <span className="text-white/60">{t("cullZoomIn")}</span>
              <kbd className="rounded-[4px] border border-white/20 bg-white/10 px-2 py-0.5 text-[11px] text-white/70">
                -
              </kbd>
              <span className="text-white/60">{t("cullZoomOut")}</span>
              <kbd className="rounded-[4px] border border-white/20 bg-white/10 px-2 py-0.5 text-[11px] text-white/70">
                0
              </kbd>
              <span className="text-white/60">{t("cullZoomFit")}</span>
              <kbd className="rounded-[4px] border border-white/20 bg-white/10 px-2 py-0.5 text-[11px] text-white/70">
                Scroll
              </kbd>
              <span className="text-white/60">{t("cullZoomScroll")}</span>
              <kbd className="rounded-[4px] border border-white/20 bg-white/10 px-2 py-0.5 text-[11px] text-white/70">
                DblClick
              </kbd>
              <span className="text-white/60">{t("cullZoomToggle")}</span>
              <kbd className="rounded-[4px] border border-white/20 bg-white/10 px-2 py-0.5 text-[11px] text-white/70">
                ?
              </kbd>
              <span className="text-white/60">{t("cullShortcuts")}</span>
            </div>
          </div>
        </button>
      )}

      {/* Fatigue reminder */}
      {fatigueOpen && (
        <Dialog onOpenChange={setFatigueOpen} open={fatigueOpen}>
          <DialogContent className="max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-[340px] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Swords className="h-4 w-4 text-primary" />
                {t("cullFatigueTitle")}
              </DialogTitle>
              <DialogDescription>{t("cullFatigueMsg")}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <button
                className="rounded-[6px] bg-primary px-4 py-2 text-[12px] text-primary-foreground transition-colors hover:bg-primary/90"
                onClick={() => setFatigueOpen(false)}
                type="button"
              >
                {t("cullFatigueDismiss")}
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
