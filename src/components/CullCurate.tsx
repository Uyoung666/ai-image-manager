import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import {
  CheckCircle,
  Eye,
  Heart,
  HelpCircle,
  SkipForward,
  Trash2,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { cullActions } from "@/actions/cull";
import { CullWaitingState } from "@/components/CullWaitingState";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ZoomableImage } from "@/components/ZoomableImage";
import { useChromeVisibility } from "@/hooks/use-chrome-visibility";
import { useDebouncedFlag } from "@/hooks/use-debounced-flag";
import type { SessionSummary } from "@/routes/cull.$sessionId";
import type { CullAvailability } from "@/types/cull";
import { type CullMediaPhoto, getCullProjectPreview } from "@/utils/cull-media";
import { cullShortcutBlocked } from "@/utils/cull-shortcuts";

// ── Types ──

interface PhotoInfo extends CullMediaPhoto {
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

interface SingleItem {
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

interface CurateResult {
  availability?: CullAvailability;
  done: boolean;
  preparing?: boolean;
  similarCount?: number;
  single?: SingleItem;
  stats: { total: number; completed: number; remaining: number };
  waiting?: boolean;
}

interface CullCurateProps {
  completionActions?: React.ReactNode;
  finishLabel?: string;
  onCompleted?: () => void;
  onMutationSuccess: () => void;
  onReview?: () => void;
  onSourceDetails?: () => void;
  quietSelectionFeedback?: boolean;
  session: Pick<
    SessionSummary,
    | "id"
    | "mode"
    | "totalPhotos"
    | "completedComparisons"
    | "keptCount"
    | "rejectedCount"
    | "status"
  >;
}

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

// ── Component ──

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: curation state and keyboard workflow are intentionally kept together
export function CullCurate({
  session,
  finishLabel,
  onMutationSuccess,
  onSourceDetails,
  onReview,
  onCompleted,
  completionActions,
  quietSelectionFeedback = false,
}: CullCurateProps) {
  const { t } = useTranslation();
  const requestedPreviewIdsRef = useRef(new Set<number>());
  const [previewResolutions, setPreviewResolutions] = useState<
    Record<
      number,
      {
        path: string | null;
        useOriginal: boolean;
        previewUrl?: string;
        originalUrl?: string;
      }
    >
  >({});

  // React 19: mark photo-switch state as non-urgent transition
  const [isTransitioning, startTransition] = useTransition();

  // Increment to trigger a fresh getNextPair IPC call
  const [photoFetchId, setPhotoFetchId] = useState(0);

  // Accumulates broken-photo IDs across the session; sent as excludeIds to
  // prevent backend from re-pairing them (infinite retry loop prevention).
  const erroredPhotosRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    erroredPhotosRef.current.clear();
  }, []);

  const photoQuery = useQuery({
    queryKey: ["cull", "pair", session.id, photoFetchId],
    queryFn: async () => {
      const excludeSessionPhotoIds = Array.from(erroredPhotosRef.current);
      const result = (await cullActions.getNextPair({
        sessionId: session.id,
        excludeSessionPhotoIds:
          excludeSessionPhotoIds.length > 0
            ? excludeSessionPhotoIds
            : undefined,
      })) as CurateResult;
      return result;
    },
    placeholderData: keepPreviousData,
    refetchInterval: (query) => {
      if (query.state.data?.availability) {
        return query.state.data.waiting ? 700 : false;
      }
      return query.state.data?.waiting || query.state.data?.preparing
        ? 700
        : false;
    },
    refetchOnWindowFocus: false,
    staleTime: 0,
    gcTime: 30_000,
  });

  const data = photoQuery.data;
  const done = data?.done ?? false;
  const reviewedThisVisit = useRef(false);
  const notifiedCompletion = useRef(false);
  useEffect(() => {
    if (data?.single) {
      reviewedThisVisit.current = true;
    }
  }, [data?.single]);

  const item = data?.single ?? null;
  const stats = data?.stats ?? null;
  const similarCount = (data as { similarCount?: number })?.similarCount ?? 0;

  useEffect(() => {
    if (item?.photo.source?.kind !== "project") {
      return;
    }
    let active = true;
    cullActions
      .getPhotoMedia({
        sessionId: session.id,
        sessionPhotoId: item.sessionPhotoId,
      })
      .then((media) => {
        if (active && media) {
          setPreviewResolutions((current) => ({
            ...current,
            [item.photo.id]: {
              path: null,
              useOriginal: false,
              previewUrl: media.previewUrl,
              originalUrl: media.originalUrl ?? undefined,
            },
          }));
        }
      })
      .catch(() => {
        /* Existing prepared preview remains usable if media resolution fails. */
      });
    return () => {
      active = false;
    };
  }, [item, session.id]);

  // 懒触发生成对比预览，并直接更新本地资源，避免刷新整条选片查询链路。
  useEffect(() => {
    if (
      item?.photo.source?.kind !== "project" &&
      !item?.photo?.duelPreviewPath &&
      item?.photo?.id &&
      !requestedPreviewIdsRef.current.has(item.photo.id)
    ) {
      const photoId = item.photo.id;
      requestedPreviewIdsRef.current.add(photoId);
      cullActions
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
  }, [item]);

  // useMutation.isPending drives button locking — no manual submittingRef

  const keepMutation = useMutation({
    mutationFn: async (current: SingleItem) => {
      await cullActions.updatePhotoStatus({
        sessionId: session.id,
        photoId: current.sessionPhotoId,
        status: "kept",
      });
    },
    onSuccess: () => {
      if (!quietSelectionFeedback) {
        toast.success(t("cullKeep"));
      }
      onMutationSuccess();
      startTransition(() => {
        setPhotoFetchId((n) => n + 1);
        setShowExif(false);
      });
    },
    onError: (err) => {
      console.error("[keep] failed:", err);
      toast.error(t("cullActionFailed"));
    },
  });

  const rejectMutation = useMutation({
    mutationFn: async (current: SingleItem) => {
      await cullActions.updatePhotoStatus({
        sessionId: session.id,
        photoId: current.sessionPhotoId,
        status: "rejected",
      });
    },
    onSuccess: () => {
      onMutationSuccess();
      startTransition(() => {
        setPhotoFetchId((n) => n + 1);
        setShowExif(false);
      });
    },
    onError: (err) => {
      console.error("[reject] failed:", err);
      toast.error(t("cullActionFailed"));
    },
  });

  const undoMutation = useMutation({
    mutationFn: async () => {
      return (await cullActions.undoLastAction({
        sessionId: session.id,
      })) as { success: boolean };
    },
    onSuccess: (result) => {
      if (result.success) {
        onMutationSuccess();
        startTransition(() => {
          setPhotoFetchId((n) => n + 1);
          setShowExif(false);
        });
      }
    },
    onError: (err) => {
      console.error("[undo] failed:", err);
      toast.error(t("cullActionFailed"));
    },
  });

  const skipSimilarMutation = useMutation({
    mutationFn: async (current: SingleItem) => {
      const result = (await cullActions.skipSimilarPhotos({
        sessionId: session.id,
        photoId: current.sessionPhotoId,
      })) as { skippedCount: number };
      return result;
    },
    onSuccess: (result) => {
      if (result.skippedCount > 0) {
        toast.success(t("cullSkippedSimilar", { count: result.skippedCount }));
      }
      onMutationSuccess();
      startTransition(() => {
        setPhotoFetchId((n) => n + 1);
        setShowExif(false);
      });
    },
    onError: (err) => {
      console.error("[skipSimilar] failed:", err);
      toast.error(t("cullActionFailed"));
    },
  });

  const completeMutation = useMutation<void, Error, boolean | undefined>({
    mutationFn: async (_notify = true) => {
      await cullActions.completeSession({ sessionId: session.id });
    },
    onSuccess: (_result, notify) => {
      onMutationSuccess();
      notifiedCompletion.current = true;
      if (notify !== false) {
        onCompleted?.();
      }
    },
    onError: (err) => {
      console.error("[complete] failed:", err);
      toast.error(t("cullActionFailed"));
    },
  });

  const autoCompleteSessionRef = useRef<number | null>(null);
  useEffect(() => {
    if (
      !(done && data?.stats.total) ||
      photoQuery.isFetching ||
      photoQuery.isPlaceholderData ||
      session.status === "completed" ||
      autoCompleteSessionRef.current === session.id
    ) {
      return;
    }
    autoCompleteSessionRef.current = session.id;
    completeMutation.mutate(reviewedThisVisit.current);
  }, [
    done,
    data?.stats.total,
    photoQuery.isFetching,
    photoQuery.isPlaceholderData,
    session.id,
    session.status,
    completeMutation.mutate,
  ]);

  const isSubmitting =
    keepMutation.isPending ||
    rejectMutation.isPending ||
    undoMutation.isPending ||
    skipSimilarMutation.isPending ||
    completeMutation.isPending ||
    photoQuery.isFetching ||
    isTransitioning;

  // Track broken photo in erroredPhotosRef, then skip to next
  const handleImageError = useCallback(() => {
    const currentItem = photoQuery.data?.single;
    if (currentItem) {
      erroredPhotosRef.current.add(currentItem.sessionPhotoId);
    }
    toast.warning(t("cullPhotoUnavailable"), { duration: 2500 });
    startTransition(() => {
      setPhotoFetchId((n) => n + 1);
      setShowExif(false);
    });
  }, [photoQuery.data?.single, t]);

  // EXIF — loaded on every photo change
  const [exif, setExif] = useState<ExifData | null>(null);
  const [showExif, setShowExif] = useState(false);

  useEffect(() => {
    if (!item) {
      setExif(null);
      return;
    }
    let cancelled = false;
    cullActions
      .getPhotoExif({
        sessionId: session.id,
        sessionPhotoId: item.sessionPhotoId,
      })
      .then((r) => {
        if (!cancelled) {
          setExif(r as ExifData | null);
        }
      })
      .catch(() => {
        /* EXIF is non-critical */
      });
    return () => {
      cancelled = true;
    };
  }, [item, session.id]);

  // Keyboard shortcuts — item data via ref to avoid stale closures
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [finishConfirmOpen, setFinishConfirmOpen] = useState(false);
  const [skipSimilarConfirmOpen, setSkipSimilarConfirmOpen] = useState(false);
  const shortcutsOpenRef = useRef(false);
  shortcutsOpenRef.current = shortcutsOpen;
  const finishConfirmOpenRef = useRef(false);
  finishConfirmOpenRef.current = finishConfirmOpen;
  const skipSimilarConfirmOpenRef = useRef(false);
  skipSimilarConfirmOpenRef.current = skipSimilarConfirmOpen;

  // Chrome auto-hide: toolbars fade out after 2s of mouse inactivity
  const chrome = useChromeVisibility({
    forceVisible: finishConfirmOpen,
  });

  const itemRef = useRef(item);
  itemRef.current = item;

  useEffect(() => {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: shortcut handler preserves the existing keyboard workflow
    function onKey(e: KeyboardEvent) {
      if (cullShortcutBlocked(e)) {
        return;
      }
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
      if (finishConfirmOpenRef.current || skipSimilarConfirmOpenRef.current) {
        return;
      }
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      const current = itemRef.current;

      if (e.key === "ArrowRight" && current && !isSubmitting) {
        e.preventDefault();
        keepMutation.mutate(current);
      } else if (
        (e.key === "ArrowLeft" || e.key === "ArrowDown" || e.key === " ") &&
        current &&
        !isSubmitting
      ) {
        e.preventDefault();
        rejectMutation.mutate(current);
      } else if (e.key === "z" && e.ctrlKey && !isSubmitting) {
        e.preventDefault();
        undoMutation.mutate();
      } else if (
        e.key === "s" &&
        !e.ctrlKey &&
        !e.metaKey &&
        current &&
        !isSubmitting
      ) {
        e.preventDefault();
        if (similarCount > 0) {
          setSkipSimilarConfirmOpen(true);
        }
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [isSubmitting, keepMutation, rejectMutation, undoMutation, similarCount]);

  // showTransition 即时拦截交互，showSpinner 经 150ms 防抖避免频闪
  const isFetchingNext = photoQuery.isFetching && !photoQuery.isLoading;
  const showTransition = isTransitioning || isFetchingNext;
  const showSpinner = useDebouncedFlag(showTransition, 150);

  if (
    done &&
    session.status !== "completed" &&
    (completeMutation.isPending || completeMutation.isError)
  ) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-3 p-4"
        role="status"
      >
        <p className="text-muted-foreground text-sm">
          {t(
            completeMutation.isError
              ? "cullActionFailed"
              : "shootingProject.saving"
          )}
        </p>
        {completeMutation.isError && (
          <button
            className="rounded border px-3 py-2 text-sm"
            onClick={() => completeMutation.mutate(reviewedThisVisit.current)}
            type="button"
          >
            {t("retry")}
          </button>
        )}
      </div>
    );
  }

  // Done state
  if (done || (completionActions && session.status === "completed")) {
    const kc = session.keptCount;
    const rc = session.rejectedCount;
    return (
      <div className="flex h-full min-h-0 overflow-y-auto p-3">
        <div className="m-auto max-w-full text-center">
          <Eye className="mx-auto h-12 w-12 text-success/50" />
          <p className="mt-4 font-medium text-[16px] text-foreground">
            {t("cullCurateComplete")}
          </p>
          <p className="mt-2 text-[13px] text-muted-foreground/70">
            {t("cullKeptCount", { count: kc })} ·{" "}
            {t("cullRejectedCount", { count: rc })}
          </p>
          {completionActions}
        </div>
      </div>
    );
  }

  // Loading (first fetch only)
  if (photoQuery.isLoading && !photoQuery.data) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner size="xl" />
      </div>
    );
  }

  if (photoQuery.isError && !photoQuery.data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-[13px] text-destructive">{t("cullActionFailed")}</p>
        <button
          className="rounded-[6px] bg-primary px-3 py-1.5 text-[12px] text-primary-foreground"
          onClick={() => photoQuery.refetch()}
          type="button"
        >
          {t("retry")}
        </button>
      </div>
    );
  }

  if (!item) {
    return (
      <CullWaitingState
        availability={data?.availability}
        onRetry={() => {
          erroredPhotosRef.current.clear();
          setPhotoFetchId((value) => value + 1);
          onMutationSuccess();
        }}
        onReview={onReview}
        onSourceDetails={onSourceDetails}
      />
    );
  }

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

  return (
    <div
      className="relative flex h-full min-h-0 min-w-0 select-none flex-col overflow-hidden bg-black"
      {...chrome}
    >
      {/* Top bar — glass overlay */}
      <div
        className={`flex shrink-0 items-center justify-between gap-3 overflow-x-auto border-white/[0.06] border-b bg-background/70 px-3 py-1.5 backdrop-blur-xl transition-opacity duration-500 sm:px-6 sm:py-2 ${
          chrome.visible ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        <span className="min-w-0 flex-1 truncate whitespace-nowrap text-[11px] text-muted-foreground/70">
          {t("cullCurateProgress", {
            done: stats?.completed ?? session.completedComparisons,
            total: stats?.total ?? session.totalPhotos,
          })}
        </span>
        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
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
            <CheckCircle className="h-3 w-3" />
            {t("cullFinish")}
          </button>
          <button
            className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[4px] px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
            data-testid="cull-curate-undo"
            disabled={isSubmitting}
            onClick={() => undoMutation.mutate()}
            type="button"
          >
            <Undo2 className="h-3 w-3" />
            {t("cullUndo")} (Ctrl+Z)
          </button>
        </div>
      </div>

      {/* Photo — full-bleed immersive */}
      <div
        className={`relative flex min-h-0 min-w-0 flex-1 animate-photo-fade-in items-center justify-center overflow-hidden ${
          showTransition ? "pointer-events-none" : ""
        }`}
        data-photo-id={item.photo.projectPhotoId ?? item.photo.id}
        data-testid="cull-curate-current"
        key={photoFetchId}
        onMouseEnter={() => setShowExif(true)}
        onMouseLeave={() => setShowExif(false)}
        role="none"
      >
        <button
          className="flex h-full min-h-0 w-full min-w-0 items-center justify-center overflow-hidden"
          data-zoom
          type="button"
        >
          <ZoomableImage
            alt={item.photo.filename}
            duelPreviewPath={
              item.photo.duelPreviewPath ??
              previewResolutions[item.photo.id]?.path
            }
            enableOriginalOnZoom={true}
            enableProgressiveLoading={true}
            filePath={item.photo.path}
            key={item.photo.id}
            onError={handleImageError}
            originalUrl={
              previewResolutions[item.photo.id]?.originalUrl ??
              item.photo.originalUrl ??
              undefined
            }
            originalWidth={item.photo.width}
            previewUrl={
              previewResolutions[item.photo.id]?.previewUrl ??
              getCullProjectPreview(item.photo)
            }
            thumbnailPath={item.photo.thumbnailPath}
            useOriginalAsPreview={
              previewResolutions[item.photo.id]?.useOriginal ?? false
            }
          />
        </button>

        {/* EXIF hover overlay — fades in on hover */}
        <div
          className={`absolute right-0 bottom-0 left-0 z-10 transition-opacity duration-200 ${
            showExif ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
        >
          <div className="mx-auto max-h-full max-w-[600px] overflow-hidden px-2 pb-2 sm:px-4 sm:pb-3">
            <div className="overflow-y-auto rounded-[8px] bg-black/75 px-3 py-1.5 sm:px-4 sm:py-2">
              <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5">
                {exif ? (
                  <>
                    {renderExifRow(t("cullFileName"), item.photo.filename)}
                    {item.photo.source?.kind === "project" &&
                      item.photo.previewWidth &&
                      item.photo.previewHeight &&
                      renderExifRow(
                        t("cullProject.previewSize", {
                          width: item.photo.previewWidth,
                          height: item.photo.previewHeight,
                          originalWidth: item.photo.width,
                          originalHeight: item.photo.height,
                        }),
                        " "
                      )}
                    {renderExifRow(
                      t("cullDateTaken"),
                      formatExifDate(exif.dateTaken)
                    )}
                    {renderExifRow(
                      t("cullDimensions"),
                      `${item.photo.width}×${item.photo.height}`
                    )}
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
                  <span className="text-[10px] text-white/40">
                    {t("cullNoExif")}
                  </span>
                )}
                {similarCount > 0 && (
                  <span className="text-[10px] text-amber-400">
                    {t("cullSimilarPhotos")}: {similarCount}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Spinner — centered overlay during transition */}
        {showSpinner && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
            <LoadingSpinner size="md" variant="overlay" />
          </div>
        )}
      </div>

      {/* Action bar — glass overlay */}
      <div
        className={`flex shrink-0 items-center justify-start gap-2 overflow-x-auto border-white/[0.06] border-t bg-background/70 px-3 py-2 backdrop-blur-xl transition-opacity duration-500 sm:justify-center sm:gap-6 sm:px-6 sm:py-3 ${
          chrome.visible ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        <button
          className="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-border bg-secondary px-3 py-2 text-[12px] text-muted-foreground transition-all hover:border-foreground/20 hover:bg-secondary/80 hover:text-foreground disabled:opacity-40 sm:px-4"
          disabled={isSubmitting || similarCount === 0}
          onClick={(_event) => {
            if (similarCount > 0) {
              setSkipSimilarConfirmOpen(true);
            }
          }}
          type="button"
        >
          <SkipForward className="h-4 w-4" />
          {t("cullSkipSimilar")} (S)
        </button>
        <button
          className="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-destructive/25 bg-destructive/[0.08] px-4 py-2 text-[13px] text-destructive backdrop-blur-md transition-all hover:border-destructive/45 hover:bg-destructive/[0.14] hover:text-destructive-foreground hover:shadow-[0_0_16px_-4px_var(--destructive)/25] disabled:opacity-40 sm:px-5 sm:py-2.5"
          data-testid="cull-curate-reject"
          disabled={isSubmitting}
          onClick={() => rejectMutation.mutate(item)}
          type="button"
        >
          <Trash2 className="h-4 w-4" />
          {t("cullReject")} ← ↓
        </button>
        <button
          className="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-amber-500/30 bg-amber-500/[0.12] px-5 py-2 font-medium text-[14px] text-foreground backdrop-blur-md transition-all hover:border-amber-500/50 hover:bg-amber-500/[0.20] hover:shadow-[0_0_20px_-4px_var(--amber-500)/30] active:scale-[0.96] disabled:opacity-40 sm:px-6 sm:py-3"
          data-testid="cull-curate-keep"
          disabled={isSubmitting}
          onClick={() => keepMutation.mutate(item)}
          type="button"
        >
          <Heart className="h-4 w-4" />
          {t("cullKeep")} →
        </button>
      </div>

      {/* Dialogs */}
      {finishConfirmOpen && (
        <Dialog onOpenChange={setFinishConfirmOpen} open={finishConfirmOpen}>
          <DialogContent className="max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{t("cullFinishConfirmTitle")}</DialogTitle>
            </DialogHeader>
            <p className="text-[13px] text-muted-foreground">
              {t("cullCurateProgress", {
                done: stats?.completed ?? session.completedComparisons,
                total: stats?.total ?? session.totalPhotos,
              })}
            </p>
            <div className="flex flex-wrap justify-end gap-2 pt-2">
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
                onClick={() => completeMutation.mutate(true)}
                type="button"
              >
                {finishLabel ?? t("cullFinishAndViewResults")}
              </button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {skipSimilarConfirmOpen && (
        <Dialog
          onOpenChange={setSkipSimilarConfirmOpen}
          open={skipSimilarConfirmOpen}
        >
          <DialogContent className="max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{t("cullSkipSimilarConfirmTitle")}</DialogTitle>
            </DialogHeader>
            <p className="text-[13px] text-muted-foreground">
              {t("cullSkipSimilarConfirmDescription", { count: similarCount })}
            </p>
            <div className="flex flex-wrap justify-end gap-2 pt-2">
              <button
                className="rounded-[6px] px-4 py-2 text-[12px] text-muted-foreground"
                onClick={() => setSkipSimilarConfirmOpen(false)}
                type="button"
              >
                {t("cancel")}
              </button>
              <button
                className="rounded-[6px] bg-destructive px-4 py-2 text-[12px] text-destructive-foreground"
                onClick={() => {
                  setSkipSimilarConfirmOpen(false);
                  skipSimilarMutation.mutate(item);
                }}
                type="button"
              >
                {t("cullRejectSimilarCount", { count: similarCount })}
              </button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Keyboard shortcuts — glass overlay */}
      {shortcutsOpen && (
        <button
          aria-label={t("close")}
          className="absolute inset-0 z-50 flex items-center justify-center overflow-hidden border-0 bg-black/20 p-2 text-left"
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
                →
              </kbd>
              <span className="text-white/60">{t("cullKeep")}</span>
              <kbd className="rounded-[4px] border border-white/20 bg-white/10 px-2 py-0.5 text-[11px] text-white/70">
                ← / ↓ / Space
              </kbd>
              <span className="text-white/60">{t("cullReject")}</span>
              <kbd className="rounded-[4px] border border-white/20 bg-white/10 px-2 py-0.5 text-[11px] text-white/70">
                S
              </kbd>
              <span className="text-white/60">{t("cullSkipSimilar")}</span>
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
    </div>
  );
}
