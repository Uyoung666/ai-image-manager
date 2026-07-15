import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ZoomableImage, type ZoomState } from "@/components/ZoomableImage";
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

export function CullDuel({ session, onMutationSuccess }: CullDuelProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

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
  }, [session.id]);

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

  // 懒触发生成对比预览：当前 pair 的照片若缺失则后台生成
  useEffect(() => {
    if (!pair) {
      return;
    }
    for (const item of pair) {
      if (!item.photo.duelPreviewPath) {
        ipc.client.cull
          .ensureDuelPreview({ photoId: item.photo.id })
          .then(() => {
            queryClient.invalidateQueries({
              queryKey: ["cull", "session", session.id],
            });
          })
          .catch(() => {
            /* 静默失败，下次重试 */
          });
      }
    }
  }, [pair, session.id, queryClient]);

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

  // Zoom sync between left/right images
  const [syncZoom, setSyncZoom] = useState(true);
  const [syncState, setSyncState] = useState<ZoomState | null>(null);
  const syncStateRef = useRef<ZoomState | null>(null);

  const sameRatio = pair
    ? Math.abs(
        pair[0].photo.width / pair[0].photo.height -
          pair[1].photo.width / pair[1].photo.height
      ) < 0.02
    : false;

  const effectiveSync = syncZoom && sameRatio;

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
  }, [session.id]);

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
  }, [pairQuery.dataUpdatedAt, pair, pairData?.reason]);

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

  function renderExifRow(label: string, value: string | null) {
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
          </>
        ) : (
          <span className="text-[10px] text-white/30">{t("cullNoExif")}</span>
        )}
      </div>
    );
  }

  return (
    <div
      className="relative flex h-full select-none flex-col bg-black"
      {...chrome}
    >
      {/* Top bar — glass overlay */}
      <div
        className={`flex items-center justify-between border-white/[0.06] border-b bg-background/70 px-6 py-2 backdrop-blur-xl transition-opacity duration-500 ${
          chrome.visible ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        <span className="text-[11px] text-muted-foreground/70">
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
            const minC =
              session.pkMode === "quick"
                ? 5
                : session.pkMode === "fine"
                  ? 12
                  : 8;
            const recompareBudget =
              session.pkMode === "quick"
                ? 0
                : session.pkMode === "fine"
                  ? Math.ceil(totalPhotos * 0.3)
                  : Math.ceil(totalPhotos * 0.15);
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
        <span className="ml-2 rounded-[3px] bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
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
        <div className="flex items-center gap-2">
          {sameRatio && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  aria-label={t("cullSyncZoomDesc")}
                  className="flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => {
                    setSyncZoom((v) => !v);
                    setSyncState(null);
                    syncStateRef.current = null;
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
            className="flex items-center gap-1 rounded-[4px] px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
            disabled={isSubmitting}
            onClick={() => setFinishConfirmOpen(true)}
          >
            <CheckCircle2 className="h-3 w-3" />
            {t("cullFinish")}
          </button>
          <button
            className="flex items-center gap-1 rounded-[4px] px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
            disabled={isSubmitting}
            onClick={() => undoMutation.mutate()}
          >
            <Undo2 className="h-3 w-3" />
            {t("cullUndo")} (Ctrl+Z)
          </button>
        </div>
      </div>

      {/* Photo pair — fade-in on swap */}
      <div
        className={`flex flex-1 animate-photo-fade-in overflow-hidden ${
          showTransition ? "pointer-events-none" : ""
        }`}
        key={pairFetchId}
      >
        {/* Left photo */}
        <div
          className="relative flex flex-1 flex-col items-center justify-center overflow-hidden"
          onMouseEnter={() => setShowExifLeft(true)}
          onMouseLeave={() => setShowExifLeft(false)}
        >
          <div className="min-h-0 flex-1" data-zoom>
            <ZoomableImage
              alt={left.photo.filename}
              duelPreviewPath={left.photo.duelPreviewPath}
              enableOriginalOnZoom={true}
              enableProgressiveLoading={true}
              filePath={left.photo.path}
              key={`L-${pairFetchId}`}
              onError={() => handleImageError("left")}
              onSync={(s) => {
                if (!effectiveSync) {
                  return;
                }
                const prev = syncStateRef.current;
                if (
                  prev &&
                  prev.scale === s.scale &&
                  prev.translate.x === s.translate.x &&
                  prev.translate.y === s.translate.y
                ) {
                  return;
                }
                syncStateRef.current = s;
                setSyncState(s);
              }}
              syncState={effectiveSync ? syncState : null}
              thumbnailPath={left.photo.thumbnailPath}
            />
          </div>

          {/* EXIF hover overlay — fades in on hover */}
          <div
            className={`pointer-events-none absolute right-0 bottom-0 left-0 z-10 transition-opacity duration-200 ${
              showExifLeft ? "opacity-100" : "opacity-0"
            }`}
          >
            <div className="mx-auto max-w-[400px] px-4 pb-14">
              <div className="rounded-[8px] bg-black/60 px-3 py-1.5 backdrop-blur-md">
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
          <div className="absolute right-0 bottom-3 left-0 z-10 flex justify-center">
            <button
              className="rounded-full border border-white/20 bg-black/40 px-4 py-1.5 text-[12px] text-white/90 backdrop-blur-md transition-all hover:border-white/35 hover:bg-black/60 hover:text-white hover:shadow-[0_0_16px_-4px_rgba(0,0,0,0.3)] active:scale-[0.96] disabled:opacity-30"
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
          <div className="relative flex h-10 w-10 items-center justify-center rounded-full border border-white/[0.10] bg-black/50 shadow-[0_0_20px_-4px_rgba(255,255,255,0.10)] backdrop-blur-xl">
            <span className="select-none font-semibold text-[11px] text-white/50 tracking-wider">
              VS
            </span>
          </div>
          {/* Bottom gradient line */}
          <div className="w-px flex-1 bg-gradient-to-b from-white/[0.10] via-white/[0.04] to-transparent" />
        </div>

        {/* Right photo */}
        <div
          className="relative flex flex-1 flex-col items-center justify-center overflow-hidden"
          onMouseEnter={() => setShowExifRight(true)}
          onMouseLeave={() => setShowExifRight(false)}
        >
          <div className="min-h-0 flex-1" data-zoom>
            <ZoomableImage
              alt={right.photo.filename}
              duelPreviewPath={right.photo.duelPreviewPath}
              enableOriginalOnZoom={true}
              enableProgressiveLoading={true}
              filePath={right.photo.path}
              key={`R-${pairFetchId}`}
              onError={() => handleImageError("right")}
              onSync={(s) => {
                if (!effectiveSync) {
                  return;
                }
                const prev = syncStateRef.current;
                if (
                  prev &&
                  prev.scale === s.scale &&
                  prev.translate.x === s.translate.x &&
                  prev.translate.y === s.translate.y
                ) {
                  return;
                }
                syncStateRef.current = s;
                setSyncState(s);
              }}
              syncState={effectiveSync ? syncState : null}
              thumbnailPath={right.photo.thumbnailPath}
            />
          </div>

          {/* EXIF hover overlay — fades in on hover */}
          <div
            className={`pointer-events-none absolute right-0 bottom-0 left-0 z-10 transition-opacity duration-200 ${
              showExifRight ? "opacity-100" : "opacity-0"
            }`}
          >
            <div className="mx-auto max-w-[400px] px-4 pb-14">
              <div className="rounded-[8px] bg-black/60 px-3 py-1.5 backdrop-blur-md">
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
          <div className="absolute right-0 bottom-3 left-0 z-10 flex justify-center">
            <button
              className="rounded-full border border-white/20 bg-black/40 px-4 py-1.5 text-[12px] text-white/90 backdrop-blur-md transition-all hover:border-white/35 hover:bg-black/60 hover:text-white hover:shadow-[0_0_16px_-4px_rgba(0,0,0,0.3)] active:scale-[0.96] disabled:opacity-30"
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
        className={`flex items-center justify-center gap-4 border-white/[0.06] border-t bg-background/70 px-6 py-3 backdrop-blur-xl transition-opacity duration-500 ${
          chrome.visible ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        <button
          className="rounded-[6px] border border-border bg-secondary px-4 py-1.5 text-[12px] text-muted-foreground transition-all hover:border-foreground/20 hover:bg-secondary/80 hover:text-foreground disabled:opacity-40"
          disabled={isSubmitting}
          onClick={() =>
            skipMutation.mutate({
              photoAId: left.sessionPhotoId,
              photoBId: right.sessionPhotoId,
            })
          }
        >
          {t("cullSkip")} (Space)
        </button>
        <button
          className="rounded-[6px] border border-border bg-secondary px-4 py-1.5 text-[12px] text-muted-foreground transition-all hover:border-foreground/20 hover:bg-secondary/80 hover:text-foreground disabled:opacity-40"
          disabled={isSubmitting}
          onClick={() =>
            submitMutation.mutate({
              winnerId: left.sessionPhotoId,
              loserId: right.sessionPhotoId,
              isDraw: true,
            })
          }
        >
          {t("cullDraw")} (D)
        </button>
        {lastReason && (
          <span className="ml-auto text-[10px] text-white/30">
            {t("cullNextPairReason")}: {lastReason}
          </span>
        )}
      </div>

      {/* Finish confirm dialog */}
      {finishConfirmOpen && (
        <Dialog onOpenChange={setFinishConfirmOpen} open={finishConfirmOpen}>
          <DialogContent>
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
              >
                {t("cancel")}
              </button>
              <button
                className="rounded-[6px] bg-primary px-4 py-2 text-[12px] text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                disabled={isSubmitting}
                onClick={() => completeMutation.mutate()}
              >
                {t("cullFinishAndViewResults")}
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Keyboard shortcuts — glass overlay */}
      {shortcutsOpen && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-black/20"
          onClick={() => {
            setShortcutsOpen(false);
            shortcutsOpenRef.current = false;
          }}
        >
          <div
            className="pointer-events-auto rounded-[12px] border border-white/[0.08] bg-black/60 px-6 py-4 shadow-[0_16px_48px_-12px_rgba(0,0,0,0.6)] backdrop-blur-xl"
            onClick={(e) => e.stopPropagation()}
          >
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
        </div>
      )}

      {/* Fatigue reminder */}
      {fatigueOpen && (
        <Dialog onOpenChange={setFatigueOpen} open={fatigueOpen}>
          <DialogContent className="max-w-[340px]">
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
