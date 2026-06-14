import { useVirtualizer } from "@tanstack/react-virtual";
import {
  CheckCircle2,
  Download,
  FolderPlus,
  Heart,
  Star,
  Trash2,
  XCircle,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AddToAlbumDialog } from "@/components/AddToAlbumDialog";
import { ExportDialog } from "@/components/ExportDialog";
import { PhotoLightbox } from "@/components/PhotoLightbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ipc } from "@/ipc/manager";
import { toLocalMediaUrl } from "@/utils/local-media-url";

interface PhotoInfo {
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

interface RankedItem {
  comparisons: number;
  id: number;
  losses: number;
  photo: PhotoInfo;
  rating: number;
  status: "pending" | "kept" | "rejected";
  wins: number;
}

interface CullResultProps {
  onUpdate?: () => void;
  session: {
    id: number;
    name: string;
    mode: string;
    items: RankedItem[];
  };
}

// ──────────────────────────────────────────────────────────────
// CullResultRow — memo'd row for virtual scrolling
// ──────────────────────────────────────────────────────────────

const CullResultRow = memo(
  function CullResultRow({
    item,
    index,
    isSelected,
    isDuel,
    onToggle,
    onStatusChange,
    onPreview,
    updating,
  }: {
    item: RankedItem;
    index: number;
    isSelected: boolean;
    isDuel: boolean;
    onToggle: (id: number) => void;
    onStatusChange: (
      id: number,
      status: "kept" | "rejected" | "pending"
    ) => void;
    onPreview: (index: number) => void;
    updating: Set<number>;
  }) {
    const { t } = useTranslation();

    function getStatusBadge(status: string) {
      switch (status) {
        case "kept":
          return (
            <span className="flex items-center gap-1 rounded-[4px] bg-success/10 px-1.5 py-0.5 font-[510] text-[10px] text-success">
              <CheckCircle2 className="h-3 w-3" />
              {t("cullKeep")}
            </span>
          );
        case "rejected":
          return (
            <span className="flex items-center gap-1 rounded-[4px] bg-destructive/10 px-1.5 py-0.5 font-[510] text-[10px] text-destructive">
              <XCircle className="h-3 w-3" />
              {t("cullReject")}
            </span>
          );
        default:
          return null;
      }
    }

    const isUpdating = updating.has(item.id);

    return (
      <div
        className={`flex cursor-pointer items-center gap-3 rounded-[8px] border p-3 transition-colors ${
          isSelected
            ? "border-primary/30 bg-primary/[0.04]"
            : item.status === "kept"
              ? "border-success/20 bg-success/[0.03]"
              : item.status === "rejected"
                ? "border-destructive/10 bg-destructive/[0.02]"
                : "border-border bg-secondary"
        }`}
        onClick={() => onToggle(item.id)}
      >
        {/* Checkbox */}
        <div
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] border-2 transition-colors ${
            isSelected
              ? "border-primary bg-primary text-primary-foreground"
              : "border-muted-foreground/30"
          }`}
        >
          {isSelected && <CheckCircle2 className="h-3.5 w-3.5" />}
        </div>

        {/* Rank */}
        <span className="w-7 text-center font-[590] text-[13px] text-muted-foreground">
          #{index + 1}
        </span>

        {/* Thumbnail */}
        <div className="h-12 w-12 shrink-0 overflow-hidden rounded-[4px] bg-muted">
          <img
            alt={item.photo.filename}
            className="h-full w-full cursor-pointer object-cover transition-opacity hover:opacity-80"
            decoding="async"
            fetchPriority="low"
            loading="lazy"
            onClick={(e) => {
              e.stopPropagation();
              onPreview(index);
            }}
            src={toLocalMediaUrl(item.photo.thumbnailPath ?? item.photo.path)}
          />
        </div>

        {/* Info */}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] text-foreground">
            {item.photo.filename}
          </p>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground/60">
            <span>
              {item.photo.width}×{item.photo.height}
            </span>
            {item.photo.isFavorite && (
              <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" />
            )}
          </div>
        </div>

        {/* Stats (duel only) */}
        {isDuel && (
          <div className="flex items-center gap-3 text-right">
            <div>
              <span className="font-[590] text-[14px] text-foreground">
                {item.rating}
              </span>
              <span className="ml-1 text-[10px] text-muted-foreground/50">
                Elo
              </span>
            </div>
            <div className="text-[10px] text-muted-foreground/50">
              <span className="text-success">{item.wins}W</span>{" "}
              <span className="text-destructive">{item.losses}L</span>
            </div>
          </div>
        )}

        {/* Status badge & per-item actions */}
        <div className="flex items-center gap-2">
          {getStatusBadge(item.status)}
          {item.status === "pending" && (
            <>
              <button
                className="rounded-[4px] bg-success/10 px-2 py-1 text-[10px] text-success transition-colors hover:bg-success/20"
                disabled={isUpdating}
                onClick={(e) => {
                  e.stopPropagation();
                  onStatusChange(item.id, "kept");
                }}
              >
                <Heart className="inline h-3 w-3" /> {t("cullKeep")}
              </button>
              <button
                className="rounded-[4px] bg-destructive/10 px-2 py-1 text-[10px] text-destructive transition-colors hover:bg-destructive/20"
                disabled={isUpdating}
                onClick={(e) => {
                  e.stopPropagation();
                  onStatusChange(item.id, "rejected");
                }}
              >
                <Trash2 className="inline h-3 w-3" /> {t("cullReject")}
              </button>
            </>
          )}
          {item.status !== "pending" && (
            <button
              className="rounded-[4px] bg-muted px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
              disabled={isUpdating}
              onClick={(e) => {
                e.stopPropagation();
                onStatusChange(item.id, "pending");
              }}
            >
              ↺
            </button>
          )}
        </div>
      </div>
    );
  },
  // Custom comparison: only re-render when observable primitives change
  (prev, next) =>
    prev.item.id === next.item.id &&
    prev.isSelected === next.isSelected &&
    prev.item.status === next.item.status &&
    prev.item.rating === next.item.rating &&
    prev.item.comparisons === next.item.comparisons &&
    prev.updating.has(prev.item.id) === next.updating.has(next.item.id)
);

// ──────────────────────────────────────────────────────────────
// CullResult — main component
// ──────────────────────────────────────────────────────────────

export function CullResult({ session, onUpdate }: CullResultProps) {
  const { t } = useTranslation();
  const [creatingAlbum, setCreatingAlbum] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [updating, setUpdating] = useState<Set<number>>(new Set());
  const isDuel = session.mode !== "curate";

  // Phase 4: Multi-select
  const [selected, setSelected] = useState<Set<number>>(new Set());

  // Phase 4: Top N
  const [topN, setTopN] = useState("");
  const [topNConfirmOpen, setTopNConfirmOpen] = useState(false);

  // Phase 4: Export & Album dialogs
  const [exportOpen, setExportOpen] = useState(false);
  const [exportIds, setExportIds] = useState<number[]>([]);
  const [albumOpen, setAlbumOpen] = useState(false);
  const [albumIds, setAlbumIds] = useState<number[]>([]);

  // Phase 4: Trash confirmation
  const [trashConfirmOpen, setTrashConfirmOpen] = useState(false);

  // Lightbox preview
  const [lightboxIndex, setLightboxIndex] = useState(-1);

  // Virtual scrolling container ref
  const containerRef = useRef<HTMLDivElement>(null);

  // ── useMemo: derived data ──

  const kept = useMemo(
    () => session.items.filter((i) => i.status === "kept"),
    [session.items]
  );
  const rejected = useMemo(
    () => session.items.filter((i) => i.status === "rejected"),
    [session.items]
  );
  const pending = useMemo(
    () => session.items.filter((i) => i.status === "pending"),
    [session.items]
  );
  const total = session.items.length;

  // Sort: duel by Elo rating desc, curate by status grouping then fileDate
  const sorted = useMemo(
    () =>
      [...session.items].sort((a, b) => {
        if (!isDuel) {
          const order: Record<string, number> = {
            kept: 0,
            pending: 1,
            rejected: 2,
          };
          const statusDiff = (order[a.status] ?? 1) - (order[b.status] ?? 1);
          if (statusDiff !== 0) {
            return statusDiff;
          }
          return (a.photo.fileDate ?? 0) - (b.photo.fileDate ?? 0);
        }
        return b.rating - a.rating;
      }),
    [session.items, isDuel]
  );

  const selectedIds = useMemo(
    () => sorted.filter((i) => selected.has(i.id)).map((i) => i.photo.id),
    [sorted, selected]
  );

  const lightboxPhotos = useMemo(() => sorted.map((i) => i.photo), [sorted]);

  // ── useVirtualizer ──

  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => 80,
    overscan: 5,
  });

  // ── useCallback: stable handler references ──

  const toggleSelect = useCallback((itemId: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (selected.size === sorted.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(sorted.map((i) => i.id)));
    }
  }, [sorted, selected.size]);

  const handleStatusChange = useCallback(
    async (itemId: number, status: "kept" | "rejected" | "pending") => {
      setUpdating((s) => new Set(s).add(itemId));
      try {
        await ipc.client.cull.updatePhotoStatus({
          sessionId: session.id,
          photoId: itemId,
          status,
        });
        if (status === "kept") {
          const item = session.items.find((i) => i.id === itemId);
          if (item) {
            await ipc.client.photos.toggleFavorite({
              ids: [item.photo.id],
              favorite: true,
            });
          }
        }
        onUpdate?.();
      } catch (err) {
        console.error("[handleStatusChange] failed:", err);
      } finally {
        setUpdating((s) => {
          const n = new Set(s);
          n.delete(itemId);
          return n;
        });
      }
    },
    [session.id, session.items, onUpdate]
  );

  // Stable callback wrapper for CullResultRow — avoids stale closures when
  // handleStatusChange reference changes but the memo'd row does not re-render.
  const handleStatusChangeRef = useRef(handleStatusChange);
  useEffect(() => {
    handleStatusChangeRef.current = handleStatusChange;
  }, [handleStatusChange]);

  const stableHandleStatusChange = useCallback(
    (itemId: number, status: "kept" | "rejected" | "pending") => {
      handleStatusChangeRef.current(itemId, status);
    },
    []
  );

  const handleBatchStatusChange = useCallback(
    async (status: "kept" | "rejected" | "pending") => {
      const items = sorted.filter((i) => selected.has(i.id));
      if (items.length === 0) {
        return;
      }
      setUpdating((s) => new Set([...s, ...items.map((i) => i.id)]));
      try {
        await ipc.client.cull.batchUpdatePhotoStatus({
          sessionId: session.id,
          photoIds: items.map((i) => i.id),
          status,
        });
        if (status === "kept") {
          const favIds = items.map((i) => i.photo.id);
          await ipc.client.photos.toggleFavorite({
            ids: favIds,
            favorite: true,
          });
        }
        setSelected(new Set());
        onUpdate?.();
      } catch (err) {
        console.error("[handleBatchStatusChange] failed:", err);
      } finally {
        setUpdating(new Set());
      }
    },
    [session.id, sorted, selected, onUpdate]
  );

  const handleTopNApply = useCallback(async () => {
    const n = Number.parseInt(topN, 10);
    if (isNaN(n) || n < 1 || n > sorted.length) {
      return;
    }
    // In duel mode, pick from top of sorted list; in curate mode, pick pending first then rejected
    const pool = isDuel
      ? sorted.slice(0, n).filter((i) => i.status !== "kept")
      : [
          ...sorted.filter((i) => i.status === "pending"),
          ...sorted.filter((i) => i.status === "rejected"),
        ].slice(0, n);
    const topItems = pool;
    if (topItems.length === 0) {
      return;
    }
    setUpdating((s) => new Set([...s, ...topItems.map((i) => i.id)]));
    try {
      await ipc.client.cull.batchUpdatePhotoStatus({
        sessionId: session.id,
        photoIds: topItems.map((i) => i.id),
        status: "kept",
      });
      const favIds = topItems.map((i) => i.photo.id);
      await ipc.client.photos.toggleFavorite({ ids: favIds, favorite: true });
      setTopN("");
      setTopNConfirmOpen(false);
      onUpdate?.();
    } catch (err) {
      console.error("[handleTopNApply] failed:", err);
    } finally {
      setUpdating(new Set());
    }
  }, [session.id, sorted, topN, isDuel, onUpdate]);

  const handleCreateAlbumFromKept = useCallback(async () => {
    if (kept.length === 0) {
      return;
    }
    setCreatingAlbum(true);
    try {
      const album = (await ipc.client.albums.createAlbum({
        name: `${session.name} · ${new Date().toLocaleDateString()}`,
      })) as { id: number };
      await ipc.client.albums.addPhotosToAlbum({
        albumId: album.id,
        photoIds: kept.map((i) => i.photo.id),
      });
      toast.success(t("cullKeptToAlbum"));
    } catch (err) {
      console.error("[handleCreateAlbum] failed:", err);
    } finally {
      setCreatingAlbum(false);
    }
  }, [session.name, kept, t]);

  const handleTrashRejected = useCallback(async () => {
    if (rejected.length === 0) {
      return;
    }
    setTrashConfirmOpen(false);
    setDeleting(true);
    try {
      await ipc.client.photos.deletePhotos({
        ids: rejected.map((i) => i.photo.id),
      });
      toast.success(t("cullRejectedToTrash"));
      onUpdate?.();
    } catch (err) {
      console.error("[handleTrashRejected] failed:", err);
    } finally {
      setDeleting(false);
    }
  }, [rejected, t, onUpdate]);

  // ── Render ──

  return (
    <div className="flex h-full flex-col">
      {/* Summary bar */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-border border-b px-6 py-2">
        <span className="text-[12px] text-muted-foreground">
          {t("cullResultsSummary", {
            total,
            kept: kept.length,
            rejected: rejected.length,
            pending: pending.length,
          })}
        </span>
        <span className="h-4 w-px bg-border" />

        {/* Top N */}
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground/60">
            {t("cullTopN")}
          </span>
          <input
            className="w-14 rounded-[4px] border border-input bg-transparent px-2 py-0.5 text-center text-[12px] text-foreground outline-none focus:border-primary"
            onChange={(e) => setTopN(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const n = Number.parseInt(topN, 10);
                if (!isNaN(n) && n >= 1 && n <= total) {
                  setTopNConfirmOpen(true);
                }
              }
            }}
            placeholder={t("cullTopNPlaceholder")}
            value={topN}
          />
          <button
            className="rounded-[4px] bg-primary/10 px-2 py-0.5 text-[11px] text-primary transition-colors hover:bg-primary/20 disabled:opacity-40"
            disabled={!topN || isNaN(Number.parseInt(topN, 10))}
            onClick={() => setTopNConfirmOpen(true)}
          >
            {t("cullTopNApply", { n: Number.parseInt(topN, 10) || 0 })}
          </button>
        </div>

        <span className="h-4 w-px bg-border" />

        {/* Export kept */}
        <button
          className="flex items-center gap-1 rounded-[4px] px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
          disabled={kept.length === 0}
          onClick={() => {
            setExportIds(kept.map((i) => i.photo.id));
            setExportOpen(true);
          }}
        >
          <Download className="h-3 w-3" />
          {t("cullExportKept")} ({kept.length})
        </button>

        {/* Create album from kept */}
        <button
          className="flex items-center gap-1 rounded-[4px] px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
          disabled={kept.length === 0 || creatingAlbum}
          onClick={handleCreateAlbumFromKept}
        >
          <FolderPlus className="h-3 w-3" />
          {t("cullCreateAlbumFromKept")} ({kept.length})
        </button>

        {/* Trash rejected */}
        <button
          className="flex items-center gap-1 rounded-[4px] px-2 py-0.5 text-[11px] text-destructive transition-colors hover:bg-destructive/5 disabled:opacity-40"
          disabled={rejected.length === 0 || deleting}
          onClick={() => setTrashConfirmOpen(true)}
        >
          <Trash2 className="h-3 w-3" />
          {t("cullTrashRejected")} ({rejected.length})
        </button>

        {/* Select all */}
        <button
          className="ml-auto rounded-[4px] px-2 py-0.5 text-[10px] text-muted-foreground/50 transition-colors hover:text-foreground"
          onClick={toggleSelectAll}
        >
          {selected.size === sorted.length
            ? t("cullDeselectAll")
            : t("cullSelectAll")}
        </button>
      </div>

      {/* Batch action bar (when items selected) */}
      {selected.size > 0 && (
        <div className="flex items-center gap-2 border-border border-b bg-primary/[0.03] px-6 py-1.5">
          <span className="text-[11px] text-muted-foreground">
            {t("photosSelected", { count: selected.size })}
          </span>
          <button
            className="rounded-[4px] bg-success/10 px-2 py-0.5 text-[10px] text-success transition-colors hover:bg-success/20"
            onClick={() => handleBatchStatusChange("kept")}
          >
            <Heart className="mr-1 inline h-3 w-3" />
            {t("cullBatchKeep")}
          </button>
          <button
            className="rounded-[4px] bg-destructive/10 px-2 py-0.5 text-[10px] text-destructive transition-colors hover:bg-destructive/20"
            onClick={() => handleBatchStatusChange("rejected")}
          >
            <Trash2 className="mr-1 inline h-3 w-3" />
            {t("cullBatchReject")}
          </button>
          <button
            className="rounded-[4px] bg-muted px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => handleBatchStatusChange("pending")}
          >
            ↺ {t("cullBatchPending")}
          </button>
          <span className="h-3 w-px bg-border" />
          <button
            className="rounded-[4px] px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => {
              setExportIds(selectedIds);
              setExportOpen(true);
            }}
          >
            <Download className="mr-1 inline h-3 w-3" />
            {t("cullExportSelected")}
          </button>
          <button
            className="rounded-[4px] px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => {
              setAlbumIds(selectedIds);
              setAlbumOpen(true);
            }}
          >
            <FolderPlus className="mr-1 inline h-3 w-3" />
            {t("cullAddToAlbumSelected")}
          </button>
        </div>
      )}

      {/* Virtual-scrolled list */}
      <div className="flex-1 overflow-y-auto p-6" ref={containerRef}>
        {sorted.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            {t("cullNoPhotosInSession")}
          </div>
        ) : (
          <div
            style={{ height: virtualizer.getTotalSize(), position: "relative" }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const item = sorted[virtualRow.index];
              return (
                <div
                  data-index={virtualRow.index}
                  key={virtualRow.key}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                    contentVisibility: "auto",
                    containIntrinsicSize: "auto 80px",
                  }}
                >
                  <CullResultRow
                    index={virtualRow.index}
                    isDuel={isDuel}
                    isSelected={selected.has(item.id)}
                    item={item}
                    onPreview={setLightboxIndex}
                    onStatusChange={stableHandleStatusChange}
                    onToggle={toggleSelect}
                    updating={updating}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Top N confirm dialog */}
      {topNConfirmOpen && (
        <Dialog onOpenChange={setTopNConfirmOpen} open={topNConfirmOpen}>
          <DialogContent className="max-w-[360px]">
            <DialogHeader>
              <DialogTitle>{t("cullTopN")}</DialogTitle>
              <DialogDescription>
                {t("cullTopNConfirm", { n: Number.parseInt(topN, 10) || 0 })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <button
                className="rounded-[6px] px-4 py-2 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => setTopNConfirmOpen(false)}
              >
                {t("cancel")}
              </button>
              <button
                className="rounded-[6px] bg-primary px-4 py-2 text-[12px] text-primary-foreground transition-colors hover:bg-primary/90"
                onClick={handleTopNApply}
              >
                {t("cullTopNApply", { n: Number.parseInt(topN, 10) || 0 })}
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Trash confirm dialog */}
      {trashConfirmOpen && (
        <Dialog onOpenChange={setTrashConfirmOpen} open={trashConfirmOpen}>
          <DialogContent className="max-w-[360px]">
            <DialogHeader>
              <DialogTitle>{t("cullTrashConfirmTitle")}</DialogTitle>
              <DialogDescription>
                {t("cullTrashConfirmMsg", { count: rejected.length })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <button
                className="rounded-[6px] px-4 py-2 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => setTrashConfirmOpen(false)}
              >
                {t("cancel")}
              </button>
              <button
                className="rounded-[6px] bg-destructive px-4 py-2 text-[12px] text-destructive-foreground transition-colors hover:bg-destructive/90"
                disabled={deleting}
                onClick={handleTrashRejected}
              >
                {t("cullTrashConfirmBtn")}
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Export dialog */}
      <ExportDialog
        onClose={() => setExportOpen(false)}
        open={exportOpen}
        photoIds={exportIds}
      />

      {/* Add to album dialog */}
      <AddToAlbumDialog
        onClose={() => setAlbumOpen(false)}
        open={albumOpen}
        photoIds={albumIds}
      />

      {/* Lightbox */}
      <PhotoLightbox
        index={lightboxIndex}
        onClose={() => setLightboxIndex(-1)}
        open={lightboxIndex >= 0}
        photos={lightboxPhotos}
      />
    </div>
  );
}
