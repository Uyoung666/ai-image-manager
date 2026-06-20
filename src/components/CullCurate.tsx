import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ZoomableImage } from "@/components/ZoomableImage";
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

interface SingleItem {
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

interface CurateResult {
  done: boolean;
  similarCount?: number;
  single?: SingleItem;
  stats: { total: number; completed: number; remaining: number };
}

interface CullCurateProps {
  onMutationSuccess: () => void;
  session: Pick<
    Session,
    "id" | "mode" | "totalPhotos" | "completedComparisons" | "items" | "status"
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

export function CullCurate({ session, onMutationSuccess }: CullCurateProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  // React 19: mark photo-switch state as non-urgent transition
  const [isTransitioning, startTransition] = useTransition();

  // Increment to trigger a fresh getNextPair IPC call
  const [photoFetchId, setPhotoFetchId] = useState(0);

  // Accumulates broken-photo IDs across the session; sent as excludeIds to
  // prevent backend from re-pairing them (infinite retry loop prevention).
  const erroredPhotosRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    erroredPhotosRef.current.clear();
  }, [session.id]);

  const photoQuery = useQuery({
    queryKey: ["cull", "pair", session.id, photoFetchId],
    queryFn: async () => {
      const excludeIds = Array.from(erroredPhotosRef.current);
      const result = (await ipc.client.cull.getNextPair({
        sessionId: session.id,
        excludeIds: excludeIds.length > 0 ? excludeIds : undefined,
      })) as CurateResult;
      return result;
    },
    placeholderData: keepPreviousData,
    staleTime: 0,
  });

  const data = photoQuery.data;
  const done = data?.done ?? false;
  const item = data?.single ?? null;
  const stats = data?.stats ?? null;
  const similarCount = (data as { similarCount?: number })?.similarCount ?? 0;

  // 主动预加载：提前获取下一张照片数据并将图片推入浏览器缓存
  useEffect(() => {
    if (!item || done) {
      return;
    }
    const nextKey = photoFetchId + 1;
    const excludeIds = Array.from(erroredPhotosRef.current);

    queryClient
      .fetchQuery<CurateResult>({
        queryKey: ["cull", "pair", session.id, nextKey],
        queryFn: async () => {
          const result = (await ipc.client.cull.getNextPair({
            sessionId: session.id,
            excludeIds: excludeIds.length > 0 ? excludeIds : undefined,
          })) as CurateResult;
          return result;
        },
        staleTime: 0,
      })
      .then((result) => {
        if (result?.single) {
          preloadImage(
            result.single.photo.duelPreviewPath ??
              result.single.photo.thumbnailPath ??
              result.single.photo.path
          );
        }
      })
      .catch(() => {
        // 静默失败 — useQuery 在激活时会自动 refetch
      });
  }, [item, done, photoFetchId, session.id, queryClient]);

  // 懒触发生成对比预览
  useEffect(() => {
    if (!item?.photo?.duelPreviewPath && item?.photo?.id) {
      ipc.client.cull
        .ensureDuelPreview({ photoId: item.photo.id })
        .then(() => {
          queryClient.invalidateQueries({
            queryKey: ["cull", "session", session.id],
          });
        })
        .catch(() => {
          /* 静默失败 */
        });
    }
  }, [item, session.id, queryClient]);

  // useMutation.isPending drives button locking — no manual submittingRef

  const keepMutation = useMutation({
    mutationFn: async (current: SingleItem) => {
      await Promise.all([
        ipc.client.photos.toggleFavorite({
          ids: [current.photo.id],
          favorite: true,
        }),
        ipc.client.cull.updatePhotoStatus({
          sessionId: session.id,
          photoId: current.sessionPhotoId,
          status: "kept",
        }),
      ]);
    },
    onSuccess: () => {
      toast.success(t("toastFavoriteAdded"));
      onMutationSuccess();
      startTransition(() => setPhotoFetchId((n) => n + 1));
    },
    onError: (err) => console.error("[keep] failed:", err),
  });

  const rejectMutation = useMutation({
    mutationFn: async (current: SingleItem) => {
      await ipc.client.cull.updatePhotoStatus({
        sessionId: session.id,
        photoId: current.sessionPhotoId,
        status: "rejected",
      });
    },
    onSuccess: () => {
      onMutationSuccess();
      startTransition(() => setPhotoFetchId((n) => n + 1));
    },
    onError: (err) => console.error("[reject] failed:", err),
  });

  const undoMutation = useMutation({
    mutationFn: async () => {
      return (await ipc.client.cull.undoLastAction({
        sessionId: session.id,
      })) as { success: boolean };
    },
    onSuccess: (result) => {
      if (result.success) {
        onMutationSuccess();
        startTransition(() => setPhotoFetchId((n) => n + 1));
      }
    },
    onError: (err) => console.error("[undo] failed:", err),
  });

  const skipSimilarMutation = useMutation({
    mutationFn: async (current: SingleItem) => {
      const result = (await ipc.client.cull.skipSimilarPhotos({
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
      startTransition(() => setPhotoFetchId((n) => n + 1));
    },
    onError: (err) => console.error("[skipSimilar] failed:", err),
  });

  const completeMutation = useMutation({
    mutationFn: async () => {
      await ipc.client.cull.completeSession({ sessionId: session.id });
    },
    onSuccess: () => onMutationSuccess(),
    onError: (err) => console.error("[complete] failed:", err),
  });

  const isSubmitting =
    keepMutation.isPending ||
    rejectMutation.isPending ||
    undoMutation.isPending ||
    skipSimilarMutation.isPending ||
    completeMutation.isPending;

  // Track broken photo in erroredPhotosRef, then skip to next
  const handleImageError = useCallback(() => {
    const currentItem = photoQuery.data?.single;
    if (currentItem) {
      erroredPhotosRef.current.add(currentItem.sessionPhotoId);
    }
    toast.warning(t("cullPhotoUnavailable"), { duration: 2500 });
    startTransition(() => setPhotoFetchId((n) => n + 1));
  }, [photoQuery.data?.single, t]);

  // EXIF — loaded on every photo change
  const [exif, setExif] = useState<ExifData | null>(null);

  useEffect(() => {
    if (!item) {
      setExif(null);
      return;
    }
    let cancelled = false;
    ipc.client.photos
      .getPhotoExif({ id: item.photo.id })
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
  }, [photoQuery.dataUpdatedAt, item]);

  // Keyboard shortcuts — item data via ref to avoid stale closures
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [finishConfirmOpen, setFinishConfirmOpen] = useState(false);
  const shortcutsOpenRef = useRef(false);
  shortcutsOpenRef.current = shortcutsOpen;
  const finishConfirmOpenRef = useRef(false);
  finishConfirmOpenRef.current = finishConfirmOpen;

  const itemRef = useRef(item);
  itemRef.current = item;

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
      if (shortcutsOpenRef.current || finishConfirmOpenRef.current) {
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
        skipSimilarMutation.mutate(current);
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [
    isSubmitting,
    keepMutation,
    rejectMutation,
    undoMutation,
    skipSimilarMutation,
  ]);

  // showTransition 即时拦截交互，showSpinner 经 150ms 防抖避免频闪
  const isFetchingNext = photoQuery.isFetching && !photoQuery.isLoading;
  const showTransition = isTransitioning || isFetchingNext;
  const showSpinner = useDebouncedFlag(showTransition, 150);

  // Done state
  if (done) {
    const kc = session.items?.filter((i) => i.status === "kept").length ?? 0;
    const rc =
      session.items?.filter((i) => i.status === "rejected").length ?? 0;
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <Eye className="mx-auto h-12 w-12 text-success/50" />
          <p className="mt-4 font-medium text-[16px] text-foreground">
            {t("cullCurateComplete")}
          </p>
          <p className="mt-2 text-[13px] text-muted-foreground/70">
            {t("cullKeptCount", { count: kc })} ·{" "}
            {t("cullRejectedCount", { count: rc })}
          </p>
        </div>
      </div>
    );
  }

  // Loading (first fetch only)
  if (photoQuery.isLoading && !photoQuery.data) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!item) {
    return null;
  }

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

  return (
    <div className="relative flex h-full select-none flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between border-border border-b px-6 py-2">
        <span className="text-[11px] text-muted-foreground/70">
          {t("cullCurateProgress", {
            done: stats?.completed ?? session.completedComparisons,
            total: stats?.total ?? session.totalPhotos,
          })}
        </span>
        <div className="flex items-center gap-2">
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
            <CheckCircle className="h-3 w-3" />
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

      {/* Photo — 0ms 硬切 */}
      <div
        className={`flex min-h-0 flex-1 items-center justify-center p-4 ${
          showTransition ? "pointer-events-none" : ""
        }`}
        key={photoFetchId}
      >
        <div
          className="flex h-full w-full items-center justify-center"
          data-zoom
        >
          <ZoomableImage
            alt={item.photo.filename}
            duelPreviewPath={item.photo.duelPreviewPath}
            enableOriginalOnZoom={true}
            enableProgressiveLoading={true}
            filePath={item.photo.path}
            key={item.photo.id}
            onError={handleImageError}
            thumbnailPath={item.photo.thumbnailPath}
          />
        </div>
      </div>

      {/* EXIF info bar */}
      <div className="border-border border-t px-6 py-2">
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5">
          {exif ? (
            <>
              {renderExifRow(t("cullFileName"), item.photo.filename)}
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
            </>
          ) : (
            <span className="text-[10px] text-muted-foreground/30">
              {t("cullNoExif")}
            </span>
          )}
          {similarCount > 0 && (
            <span className="text-[10px] text-primary">
              {t("cullSimilarPhotos")}: {similarCount}
            </span>
          )}
        </div>
      </div>

      {/* 防抖 Spinner — 操作栏内部，图像区域之外 */}
      <div className="flex items-center justify-center border-border border-t px-6 py-1.5">
        {showSpinner && (
          <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
        )}
      </div>

      {/* Action bar */}
      <div className="flex items-center justify-center gap-6 border-border border-t px-6 py-3">
        <button
          className="flex items-center gap-2 rounded-full border border-border px-4 py-2 text-[12px] text-muted-foreground transition-all hover:border-primary/30 hover:bg-primary/5 disabled:opacity-40"
          disabled={isSubmitting}
          onClick={() => skipSimilarMutation.mutate(item)}
        >
          <SkipForward className="h-4 w-4" />
          {t("cullSkipSimilar")} (S)
        </button>
        <button
          className="flex items-center gap-2 rounded-full border border-border px-5 py-2.5 text-[13px] text-muted-foreground transition-all hover:border-destructive/30 hover:bg-destructive/5 hover:text-destructive disabled:opacity-40"
          disabled={isSubmitting}
          onClick={() => rejectMutation.mutate(item)}
        >
          <Trash2 className="h-4 w-4" />
          {t("cullReject")} ← ↓
        </button>
        <button
          className="flex items-center gap-2 rounded-full border border-success/30 bg-success/5 px-6 py-3 font-medium text-[14px] text-success transition-all hover:bg-success/10 hover:shadow-md disabled:opacity-40"
          disabled={isSubmitting}
          onClick={() => keepMutation.mutate(item)}
        >
          <Heart className="h-4 w-4" />
          {t("cullKeep")} →
        </button>
      </div>

      {/* Dialogs */}
      {finishConfirmOpen && (
        <Dialog onOpenChange={setFinishConfirmOpen} open={finishConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("cullFinishConfirmTitle")}</DialogTitle>
            </DialogHeader>
            <p className="text-[13px] text-muted-foreground">
              {t("cullCurateProgress", {
                done: stats?.completed ?? session.completedComparisons,
                total: stats?.total ?? session.totalPhotos,
              })}
            </p>
            <div className="flex justify-end gap-2 pt-2">
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
            </div>
          </DialogContent>
        </Dialog>
      )}

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
                  →
                </kbd>{" "}
                <span>{t("cullKeep")}</span>
              </p>
              <p className="flex justify-between">
                <kbd className="rounded-[3px] bg-muted px-1.5 text-[11px]">
                  ← / ↓ / Space
                </kbd>{" "}
                <span>{t("cullReject")}</span>
              </p>
              <p className="flex justify-between">
                <kbd className="rounded-[3px] bg-muted px-1.5 text-[11px]">
                  S
                </kbd>{" "}
                <span>{t("cullSkipSimilar")}</span>
              </p>
              <p className="flex justify-between">
                <kbd className="rounded-[3px] bg-muted px-1.5 text-[11px]">
                  Ctrl+Z
                </kbd>{" "}
                <span>{t("cullUndo")}</span>
              </p>
              <p className="flex justify-between">
                <kbd className="rounded-[3px] bg-muted px-1.5 text-[11px]">
                  Scroll
                </kbd>{" "}
                <span>{t("cullZoom100")}</span>
              </p>
              <p className="flex justify-between">
                <kbd className="rounded-[3px] bg-muted px-1.5 text-[11px]">
                  DblClick
                </kbd>{" "}
                <span>{t("cullZoom100")}</span>
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
    </div>
  );
}
