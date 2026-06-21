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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ZoomableImage, type ZoomState } from "@/components/ZoomableImage";
import { useDebouncedFlag } from "@/hooks/use-debounced-flag";
import { ipc } from "@/ipc/manager";
import type { Session } from "@/routes/cull.$sessionId";
import { preloadImage } from "@/utils/local-media-url";

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
    Session,
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
      const excludeIds = Array.from(erroredPhotosRef.current);
      const result = (await ipc.client.cull.getNextPair({
        sessionId: session.id,
        excludeIds: excludeIds.length > 0 ? excludeIds : undefined,
      })) as PairResult;
      return result;
    },
    placeholderData: keepPreviousData,
    // pairFetchId changes force a fresh fetch each time
    staleTime: 0,
  });

  const pairData = pairQuery.data;
  const done = pairData?.done ?? false;
  const pair = pairData?.pair;
  const stats = pairData?.stats ?? null;
  const isSessionCompleted = done || session.status === "completed";

  // 主动预加载：提前获取下一组 pair 数据并将图片推入浏览器缓存
  useEffect(() => {
    if (!pairData?.pair || pairData.done) {
      return;
    }
    const nextKey = pairFetchId + 1;
    const excludeIds = Array.from(erroredPhotosRef.current);

    queryClient
      .fetchQuery<PairResult>({
        queryKey: ["cull", "pair", session.id, nextKey],
        queryFn: async () => {
          const result = (await ipc.client.cull.getNextPair({
            sessionId: session.id,
            excludeIds: excludeIds.length > 0 ? excludeIds : undefined,
          })) as PairResult;
          return result;
        },
        staleTime: 0,
      })
      .then((result) => {
        if (result?.pair) {
          // 优先预加载对比预览，再降级到缩略图
          preloadImage(
            result.pair[0].photo.duelPreviewPath ??
              result.pair[0].photo.thumbnailPath ??
              result.pair[0].photo.path
          );
          preloadImage(
            result.pair[1].photo.duelPreviewPath ??
              result.pair[1].photo.thumbnailPath ??
              result.pair[1].photo.path
          );
        }
      })
      .catch(() => {
        // 静默失败 — useQuery 在激活时会自动 refetch
      });
  }, [pairData?.pair, pairData?.done, pairFetchId, session.id, queryClient]);

  // 懒触发生成对比预览：当前 pair 的照片若缺失则后台生成
  useEffect(() => {
    if (!pair) return;
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
      startTransition(() => setPairFetchId((n) => n + 1));
    },
    onError: (err) => {
      console.error("[submitComparison] failed:", err);
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
      startTransition(() => setPairFetchId((n) => n + 1));
    },
    onError: (err) => {
      console.error("[recordSkip] failed:", err);
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
      startTransition(() => setPairFetchId((n) => n + 1));
    },
    onError: (err) => {
      console.error("[undoLastAction] failed:", err);
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
    },
  });

  // Unified "is submitting" gate — disables all action buttons
  const isSubmitting =
    submitMutation.isPending ||
    skipMutation.isPending ||
    undoMutation.isPending ||
    completeMutation.isPending;

  // On image load failure: track the broken ID in erroredPhotosRef,
  // then skip to next pair without submitting a comparison.
  const handleImageError = useCallback(
    (side: "left" | "right") => {
      const current = pairQuery.data?.pair;
      if (!current) {
        return;
      }

      const errored = side === "left" ? current[0] : current[1];
      erroredPhotosRef.current.add(errored.photo.id);

      toast.warning(t("cullPhotoUnavailable"), { duration: 2500 });

      // Skip without submitting — server-side progress stays correct
      startTransition(() => setPairFetchId((n) => n + 1));
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
        e.stopPropagation();
        setShortcutsOpen((prev) => {
          shortcutsOpenRef.current = !prev;
          return !prev;
        });
        return;
      }
      if (
        shortcutsOpenRef.current ||
        fatigueOpenRef.current ||
        finishConfirmOpenRef.current
      ) {
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
              {stats.total} {t("photos")} · {stats.completed} PKs
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
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
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
      <span className="text-[10px] text-muted-foreground/50">
        {label}: {value}
      </span>
    );
  }

  function renderExifInfo(exif: ExifData | null, photo: PhotoInfo) {
    return (
      <div className="mt-2 flex max-w-[400px] flex-wrap items-center justify-center gap-x-3 gap-y-0.5">
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
          <span className="text-[10px] text-muted-foreground/30">
            {t("cullNoExif")}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="relative flex h-full select-none flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between border-border border-b px-6 py-2">
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
            <button
              className="flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => {
                setSyncZoom((v) => !v);
                setSyncState(null);
                syncStateRef.current = null;
              }}
              title={t("cullSyncZoomDesc")}
            >
              {syncZoom ? (
                <Link className="h-3 w-3" />
              ) : (
                <Unlink className="h-3 w-3" />
              )}
            </button>
          )}
          <button
            className="flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => {
              shortcutsOpenRef.current = true;
              setShortcutsOpen(true);
            }}
          >
            <HelpCircle className="h-3 w-3" />
          </button>
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

      {/* 0ms 硬切，key 驱除 ZoomableImage 重新挂载 */}
      <div
        className={`flex flex-1 overflow-hidden ${
          showTransition ? "pointer-events-none" : ""
        }`}
        key={pairFetchId}
      >
        {/* Left photo */}
        <div
          className="flex flex-1 cursor-pointer flex-col items-center justify-center overflow-hidden border-border border-r p-4 transition-colors hover:bg-primary/5 focus:outline-none"
          onClick={(e) => {
            if (isSubmitting) {
              return;
            }
            if (e.detail !== 1) {
              return;
            }
            if (
              e.target instanceof HTMLElement &&
              e.target.closest("[data-zoom]")
            ) {
              return;
            }
            submitMutation.mutate({
              winnerId: left.sessionPhotoId,
              loserId: right.sessionPhotoId,
            });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !isSubmitting) {
              submitMutation.mutate({
                winnerId: left.sessionPhotoId,
                loserId: right.sessionPhotoId,
              });
            }
          }}
          role="button"
          tabIndex={0}
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
          <div className="mt-2 shrink-0 text-center">
            {renderExifInfo(exifLeft, left.photo)}
            <div className="mt-1 flex items-center justify-center gap-3 text-[10px] text-muted-foreground/60">
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
          <div
            className={`mt-2 shrink-0 rounded-[6px] bg-primary/10 px-4 py-2 font-medium text-[13px] text-primary transition-all ${
              isSubmitting ? "opacity-30" : "hover:bg-primary/20"
            }`}
          >
            {t("cullPickLeft")} ←
          </div>
        </div>

        {/* VS divider */}
        <div className="absolute top-1/2 left-1/2 z-10 -translate-x-1/2 -translate-y-1/2 select-none rounded-full border border-border bg-background px-3 py-1.5 font-semibold text-[11px] text-muted-foreground shadow-sm">
          VS
        </div>

        {/* Right photo */}
        <div
          className="flex flex-1 cursor-pointer flex-col items-center justify-center overflow-hidden p-4 transition-colors hover:bg-primary/5 focus:outline-none"
          onClick={(e) => {
            if (isSubmitting) {
              return;
            }
            if (e.detail !== 1) {
              return;
            }
            if (
              e.target instanceof HTMLElement &&
              e.target.closest("[data-zoom]")
            ) {
              return;
            }
            submitMutation.mutate({
              winnerId: right.sessionPhotoId,
              loserId: left.sessionPhotoId,
            });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !isSubmitting) {
              submitMutation.mutate({
                winnerId: right.sessionPhotoId,
                loserId: left.sessionPhotoId,
              });
            }
          }}
          role="button"
          tabIndex={0}
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
          <div className="mt-2 shrink-0 text-center">
            {renderExifInfo(exifRight, right.photo)}
            <div className="mt-1 flex items-center justify-center gap-3 text-[10px] text-muted-foreground/60">
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
          <div
            className={`mt-2 shrink-0 rounded-[6px] bg-primary/10 px-4 py-2 font-medium text-[13px] text-primary transition-all ${
              isSubmitting ? "opacity-30" : "hover:bg-primary/20"
            }`}
          >
            → {t("cullPickRight")}
          </div>
        </div>
      </div>

      {/* 防抖 Spinner — 仅过渡持续 > 150ms 时挂载 */}
      {showSpinner && (
        <div className="absolute top-1/2 left-1/2 z-20 -translate-x-1/2 -translate-y-1/2">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
        </div>
      )}

      {/* Bottom bar */}
      <div className="flex items-center justify-center gap-4 border-border border-t px-6 py-3">
        <button
          className="rounded-[6px] border border-input px-4 py-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
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
          className="rounded-[6px] border border-input px-4 py-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
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
          <span className="ml-auto text-[10px] text-muted-foreground/40">
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

      {/* Keyboard shortcuts dialog */}
      {shortcutsOpen && (
        <Dialog
          onOpenChange={(open) => {
            setShortcutsOpen(open);
            if (!open) {
              shortcutsOpenRef.current = false;
            }
          }}
          open={shortcutsOpen}
        >
          <DialogContent className="max-w-[360px]">
            <DialogHeader>
              <DialogTitle>{t("cullShortcuts")}</DialogTitle>
            </DialogHeader>
            <div className="space-y-2 py-2 text-[12px] text-muted-foreground">
              <p className="flex justify-between">
                <kbd className="rounded-[3px] bg-muted px-1.5 text-[11px]">
                  ←
                </kbd>{" "}
                <span>{t("cullPickLeft")}</span>
              </p>
              <p className="flex justify-between">
                <kbd className="rounded-[3px] bg-muted px-1.5 text-[11px]">
                  →
                </kbd>{" "}
                <span>{t("cullPickRight")}</span>
              </p>
              <p className="flex justify-between">
                <kbd className="rounded-[3px] bg-muted px-1.5 text-[11px]">
                  Space
                </kbd>{" "}
                <span>{t("cullSkip")}</span>
              </p>
              <p className="flex justify-between">
                <kbd className="rounded-[3px] bg-muted px-1.5 text-[11px]">
                  D
                </kbd>{" "}
                <span>{t("cullDraw")}</span>
              </p>
              <p className="flex justify-between">
                <kbd className="rounded-[3px] bg-muted px-1.5 text-[11px]">
                  Ctrl+Z
                </kbd>{" "}
                <span>{t("cullUndo")}</span>
              </p>
              <p className="flex justify-between">
                <kbd className="rounded-[3px] bg-muted px-1.5 text-[11px]">
                  +
                </kbd>{" "}
                <span>{t("cullZoomIn")}</span>
              </p>
              <p className="flex justify-between">
                <kbd className="rounded-[3px] bg-muted px-1.5 text-[11px]">
                  -
                </kbd>{" "}
                <span>{t("cullZoomOut")}</span>
              </p>
              <p className="flex justify-between">
                <kbd className="rounded-[3px] bg-muted px-1.5 text-[11px]">
                  0
                </kbd>{" "}
                <span>{t("cullZoomFit")}</span>
              </p>
              <p className="flex justify-between">
                <kbd className="rounded-[3px] bg-muted px-1.5 text-[11px]">
                  Scroll
                </kbd>{" "}
                <span>{t("cullZoomScroll")}</span>
              </p>
              <p className="flex justify-between">
                <kbd className="rounded-[3px] bg-muted px-1.5 text-[11px]">
                  DblClick
                </kbd>{" "}
                <span>{t("cullZoomToggle")}</span>
              </p>
              <p className="flex justify-between">
                <kbd className="rounded-[3px] bg-muted px-1.5 text-[11px]">
                  ?
                </kbd>{" "}
                <span>{t("cullShortcuts")}</span>
              </p>
            </div>
          </DialogContent>
        </Dialog>
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
