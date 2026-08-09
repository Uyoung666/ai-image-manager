import { useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  CheckCircle2,
  Download,
  FolderPlus,
  Heart,
  LayoutGrid,
  LayoutList,
  Star,
  Trash2,
  Undo2,
  XCircle,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AddToAlbumDialog } from "@/components/AddToAlbumDialog";
import { ExportDialog } from "@/components/ExportDialog";
import { FilterDropdown } from "@/components/filter-dropdown";
import { PhotoLightbox } from "@/components/PhotoLightbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
// CullResultCard — memo'd gallery card
// ──────────────────────────────────────────────────────────────

const CullResultCard = memo(
  function CullResultCard({
    item,
    index,
    isSelected,
    isDuel,
    onSelect,
    onStatusChange,
    onPreview,
    updating,
  }: {
    item: RankedItem;
    index: number;
    isSelected: boolean;
    isDuel: boolean;
    onSelect: (id: number, index: number, e: React.MouseEvent) => void;
    onStatusChange: (
      id: number,
      status: "kept" | "rejected" | "pending"
    ) => void;
    onPreview: (index: number) => void;
    updating: Set<number>;
  }) {
    const { t } = useTranslation();
    const isUpdating = updating.has(item.id);
    const isKept = item.status === "kept";
    const isRejected = item.status === "rejected";

    return (
      <div
        className={`group relative flex cursor-pointer flex-col overflow-hidden rounded-[8px] transition-all duration-200 ${
          isSelected
            ? "scale-[1.02] ring-2 ring-primary ring-offset-1 ring-offset-background"
            : isKept
              ? "shadow-[0_0_12px_-2px_rgba(251,191,36,0.12)] ring-1 ring-amber-400/30"
              : isRejected
                ? "opacity-60 grayscale-[20%]"
                : "hover:scale-[1.01]"
        }`}
        data-card=""
        data-card-id={item.id}
        onClick={(e) => onSelect(item.id, index, e)}
        onDoubleClick={() => onPreview(index)}
      >
        {/* Thumbnail */}
        <div className="relative aspect-[4/3] overflow-hidden bg-muted">
          <img
            alt={item.photo.filename}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
            decoding="async"
            loading="lazy"
            src={toLocalMediaUrl(item.photo.thumbnailPath ?? item.photo.path)}
          />

          {/* Bottom gradient overlay */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-black/60 to-transparent" />

          {/* Select checkbox (top-left, visible on hover or when selected) */}
          <div
            className={`pointer-events-none absolute top-2 left-2 z-10 flex h-5 w-5 items-center justify-center rounded-[4px] border-2 transition-all ${
              isSelected
                ? "border-primary bg-primary text-primary-foreground"
                : "border-white/50 bg-black/40 opacity-0 group-hover:opacity-100"
            }`}
          >
            {isSelected && <CheckCircle2 className="h-3 w-3" />}
          </div>

          {/* Status badge (top-right) */}
          {item.status !== "pending" && (
            <div className="absolute top-2 right-2">
              {isKept ? (
                <span className="flex items-center gap-1 rounded-[4px] bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-200 backdrop-blur-sm">
                  <Heart className="h-3 w-3" fill="currentColor" />
                </span>
              ) : (
                <span className="flex items-center gap-1 rounded-[4px] bg-black/40 px-1.5 py-0.5 text-[10px] text-white/60 backdrop-blur-sm">
                  <XCircle className="h-3 w-3" />
                </span>
              )}
            </div>
          )}

          {/* Heart watermark for kept items */}
          {isKept && (
            <div className="pointer-events-none absolute right-1 bottom-1 z-[5] select-none text-[72px] text-white/10 leading-none">
              ♥
            </div>
          )}

          {/* Rank + Duel stats overlay at bottom */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between px-2 pb-1.5">
            <span className="font-semibold text-[11px] text-white/80">
              #{index + 1}
            </span>
            {isDuel && (
              <span className="text-[11px] text-white/70">
                {item.rating}
                <span className="ml-0.5 text-[9px] text-white/40">Elo</span>
              </span>
            )}
          </div>
        </div>

        {/* Info bar */}
        <div className="flex items-center gap-1.5 px-2.5 py-2">
          <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">
            {item.photo.filename}
          </span>
          {item.photo.isFavorite && (
            <Star className="h-3 w-3 shrink-0 fill-yellow-400 text-yellow-400" />
          )}

          {/* Quick actions */}
          <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            {item.status === "pending" ? (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      aria-label={t("cullKeep")}
                      className="rounded-[4px] bg-success/10 p-1 text-[10px] text-success hover:bg-success/20"
                      disabled={isUpdating}
                      onClick={(e) => {
                        e.stopPropagation();
                        onStatusChange(item.id, "kept");
                      }}
                      type="button"
                    >
                      <Heart className="h-3 w-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{t("cullKeep")}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      aria-label={t("cullReject")}
                      className="rounded-[4px] bg-destructive/10 p-1 text-[10px] text-destructive hover:bg-destructive/20"
                      disabled={isUpdating}
                      onClick={(e) => {
                        e.stopPropagation();
                        onStatusChange(item.id, "rejected");
                      }}
                      type="button"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{t("cullReject")}</TooltipContent>
                </Tooltip>
              </>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    aria-label={t("cullUndo")}
                    className="rounded-[4px] bg-muted p-1 text-[10px] text-muted-foreground hover:text-foreground"
                    disabled={isUpdating}
                    onClick={(e) => {
                      e.stopPropagation();
                      onStatusChange(item.id, "pending");
                    }}
                    type="button"
                  >
                    ↺
                  </button>
                </TooltipTrigger>
                <TooltipContent>{t("cullUndo")}</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      </div>
    );
  },
  (prev, next) =>
    prev.item.id === next.item.id &&
    prev.isSelected === next.isSelected &&
    prev.item.status === next.item.status &&
    prev.item.rating === next.item.rating &&
    prev.item.comparisons === next.item.comparisons &&
    prev.updating.has(prev.item.id) === next.updating.has(next.item.id)
);

// ──────────────────────────────────────────────────────────────
// CullResultRow — memo'd list row (original view)
// ──────────────────────────────────────────────────────────────

const CullResultRow = memo(function CullResultRow({
  item,
  index,
  isSelected,
  isDuel,
  onSelect,
  onStatusChange,
  onPreview,
  updating,
}: {
  item: RankedItem;
  index: number;
  isSelected: boolean;
  isDuel: boolean;
  onSelect: (id: number, index: number, e: React.MouseEvent) => void;
  onStatusChange: (id: number, status: "kept" | "rejected" | "pending") => void;
  onPreview: (index: number) => void;
  updating: Set<number>;
}) {
  const { t } = useTranslation();
  const isUpdating = updating.has(item.id);

  return (
    <div
      className={`flex cursor-pointer flex-wrap items-center gap-3 rounded-[8px] border p-3 transition-colors ${
        isSelected
          ? "border-primary/30 bg-primary/[0.04]"
          : item.status === "kept"
            ? "border-success/20 bg-success/[0.03]"
            : item.status === "rejected"
              ? "border-destructive/10 bg-destructive/[0.02]"
              : "border-border bg-secondary"
      }`}
      onClick={(e) => onSelect(item.id, index, e)}
    >
      <div
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] border-2 transition-colors ${
          isSelected
            ? "border-primary bg-primary text-primary-foreground"
            : "border-muted-foreground/30"
        }`}
      >
        {isSelected && <CheckCircle2 className="h-3.5 w-3.5" />}
      </div>
      <span className="w-7 text-center font-semibold text-[13px] text-muted-foreground">
        #{index + 1}
      </span>
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
      {isDuel && (
        <div className="flex shrink-0 items-center gap-3 text-right">
          <div>
            <span className="font-semibold text-[14px] text-foreground">
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
      <div className="flex shrink-0 items-center gap-2 max-[760px]:ml-auto max-[760px]:w-full max-[760px]:justify-end">
        {item.status === "kept" && (
          <span className="flex items-center gap-1 rounded-[4px] bg-success/10 px-1.5 py-0.5 font-medium text-[10px] text-success">
            <CheckCircle2 className="h-3 w-3" />
            {t("cullKeep")}
          </span>
        )}
        {item.status === "rejected" && (
          <span className="flex items-center gap-1 rounded-[4px] bg-destructive/10 px-1.5 py-0.5 font-medium text-[10px] text-destructive">
            <XCircle className="h-3 w-3" />
            {t("cullReject")}
          </span>
        )}
        {item.status === "pending" ? (
          <>
            <button
              className="rounded-[4px] bg-success/10 px-2 py-1 text-[10px] text-success transition-colors hover:bg-success/20"
              disabled={isUpdating}
              onClick={(e) => {
                e.stopPropagation();
                onStatusChange(item.id, "kept");
              }}
              type="button"
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
              type="button"
            >
              <Trash2 className="inline h-3 w-3" /> {t("cullReject")}
            </button>
          </>
        ) : (
          <button
            className="rounded-[4px] bg-muted px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            disabled={isUpdating}
            onClick={(e) => {
              e.stopPropagation();
              onStatusChange(item.id, "pending");
            }}
            type="button"
          >
            ↺
          </button>
        )}
      </div>
    </div>
  );
});

// ──────────────────────────────────────────────────────────────
// CullResult — main component
// ──────────────────────────────────────────────────────────────

export function CullResult({ session, onUpdate }: CullResultProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
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

  // View mode toggle
  const [viewMode, setViewMode] = useState<"list" | "gallery">(() => {
    try {
      return localStorage.getItem("cull.resultView") === "list"
        ? "list"
        : "gallery";
    } catch {
      return "gallery";
    }
  });
  const [galleryColumns, setGalleryColumns] = useState(5);
  const [statusFilter, setStatusFilter] = useState<
    "all" | "pending" | "kept" | "rejected"
  >("all");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [resultSort, setResultSort] = useState<
    "default" | "dateAsc" | "dateDesc"
  >("default");

  useEffect(() => {
    try {
      localStorage.setItem("cull.resultView", viewMode);
    } catch {
      // Preferences are non-critical.
    }
  }, [viewMode]);

  // Virtual scrolling container ref
  const containerRef = useRef<HTMLDivElement>(null);

  // ── Marquee selection state ──
  const [marquee, setMarquee] = useState<{
    startX: number;
    startY: number;
    x: number;
    y: number;
  } | null>(null);
  const marqueeStartScrollRef = useRef(0);
  const lastClickedIndexRef = useRef<number | null>(null);

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
        if (resultSort === "dateAsc") {
          return (a.photo.fileDate ?? 0) - (b.photo.fileDate ?? 0);
        }
        if (resultSort === "dateDesc") {
          return (b.photo.fileDate ?? 0) - (a.photo.fileDate ?? 0);
        }
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
    [session.items, isDuel, resultSort]
  );
  const visibleItems = useMemo(
    () =>
      sorted.filter(
        (item) =>
          (statusFilter === "all" || item.status === statusFilter) &&
          (!favoriteOnly || Boolean(item.photo.isFavorite))
      ),
    [sorted, statusFilter, favoriteOnly]
  );
  const rankedForTopN = useMemo(
    () => [...session.items].sort((a, b) => b.rating - a.rating),
    [session.items]
  );

  const selectedIds = useMemo(
    () => sorted.filter((i) => selected.has(i.id)).map((i) => i.photo.id),
    [sorted, selected]
  );

  const lightboxPhotos = useMemo(
    () => visibleItems.map((i) => i.photo),
    [visibleItems]
  );

  // ── useVirtualizer (list view only) ──
  const virtualizer = useVirtualizer({
    count: visibleItems.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => 80,
    overscan: 5,
  });
  const galleryRowCount = Math.ceil(visibleItems.length / galleryColumns);
  const galleryVirtualizer = useVirtualizer({
    count: galleryRowCount,
    getScrollElement: () => containerRef.current,
    estimateSize: () => 220,
    overscan: 3,
  });

  useEffect(() => {
    if (viewMode !== "gallery") {
      return;
    }
    const element = containerRef.current;
    if (!element) {
      return;
    }
    const updateColumns = () => {
      const width = element.clientWidth;
      if (width >= 1280) {
        setGalleryColumns(5);
      } else if (width >= 1024) {
        setGalleryColumns(4);
      } else if (width >= 640) {
        setGalleryColumns(3);
      } else {
        setGalleryColumns(1);
      }
    };
    updateColumns();
    const observer = new ResizeObserver(updateColumns);
    observer.observe(element);
    return () => observer.disconnect();
  }, [viewMode]);

  // ── useCallback: stable handler references ──

  // Card click with Ctrl/Shift modifier support
  const handleCardSelect = useCallback(
    (itemId: number, index: number, e: React.MouseEvent) => {
      if (e.ctrlKey || e.metaKey) {
        // Ctrl/Cmd + click: toggle single item
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(itemId)) {
            next.delete(itemId);
          } else {
            next.add(itemId);
          }
          return next;
        });
        lastClickedIndexRef.current = index;
      } else if (e.shiftKey && lastClickedIndexRef.current !== null) {
        // Shift + click: range select from last clicked index
        const start = Math.min(lastClickedIndexRef.current, index);
        const end = Math.max(lastClickedIndexRef.current, index);
        setSelected(
          new Set(visibleItems.slice(start, end + 1).map((i) => i.id))
        );
      } else {
        // Plain click: single select, clear others
        setSelected(new Set([itemId]));
        lastClickedIndexRef.current = index;
      }
    },
    [visibleItems]
  );

  // ── Marquee selection handlers ──
  const handleMarqueeStart = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) {
      return;
    }
    const target = e.target as HTMLElement;
    if (target.closest("[data-card]")) {
      return;
    }

    const scrollEl = containerRef.current;
    if (!scrollEl) {
      return;
    }
    const rect = scrollEl.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top + scrollEl.scrollTop;
    marqueeStartScrollRef.current = scrollEl.scrollTop;
    setMarquee({ startX: x, startY: y, x, y });
  }, []);

  // Marquee mousemove/mouseup effect
  useEffect(() => {
    if (!marquee) {
      return;
    }
    const scrollEl = containerRef.current;
    if (!scrollEl) {
      return;
    }

    const handleMouseMove = (e: MouseEvent) => {
      const rect = scrollEl.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top + scrollEl.scrollTop;
      setMarquee((prev) => (prev ? { ...prev, x, y } : null));
    };

    const handleMouseUp = () => {
      setMarquee((prev) => {
        if (!prev) {
          return null;
        }
        const minX = Math.min(prev.startX, prev.x);
        const maxX = Math.max(prev.startX, prev.x);
        const minY = Math.min(prev.startY, prev.y);
        const maxY = Math.max(prev.startY, prev.y);

        // Only select if drag was meaningful (> 5px in either axis)
        if (maxX - minX > 5 || maxY - minY > 5) {
          const scrollEl = containerRef.current;
          if (!scrollEl) {
            return null;
          }
          const scrollRect = scrollEl.getBoundingClientRect();
          const cards = scrollEl.querySelectorAll("[data-card]");
          const selectedIds = new Set<number>();

          for (const card of cards) {
            const cardRect = card.getBoundingClientRect();
            const cardLeft = cardRect.left - scrollRect.left;
            const cardRight = cardRect.right - scrollRect.left;
            const cardTop = cardRect.top - scrollRect.top + scrollEl.scrollTop;
            const cardBottom =
              cardRect.bottom - scrollRect.top + scrollEl.scrollTop;

            if (
              cardLeft < maxX &&
              cardRight > minX &&
              cardTop < maxY &&
              cardBottom > minY
            ) {
              const idAttr = (card as HTMLElement).dataset.cardId;
              if (idAttr) {
                selectedIds.add(Number(idAttr));
              }
            }
          }

          if (selectedIds.size > 0) {
            setSelected(selectedIds);
          }
        } else {
          // Very short drag (< 5px) — treat as blank space click, clear selection
          setSelected(new Set());
        }
        return null;
      });
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [marquee]);

  const toggleSelectAll = useCallback(() => {
    const visibleSelectedCount = visibleItems.filter((item) =>
      selected.has(item.id)
    ).length;
    if (visibleSelectedCount === visibleItems.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(visibleItems.map((i) => i.id)));
    }
  }, [visibleItems, selected]);

  const handleStatusChange = useCallback(
    async (itemId: number, status: "kept" | "rejected" | "pending") => {
      setUpdating((s) => new Set(s).add(itemId));
      try {
        await ipc.client.cull.updatePhotoStatus({
          sessionId: session.id,
          photoId: itemId,
          status,
        });
        queryClient.invalidateQueries({
          queryKey: ["photos"],
          refetchType: "active",
        });
        onUpdate?.();
      } catch (err) {
        console.error("[handleStatusChange] failed:", err);
        toast.error(t("cullActionFailed"));
      } finally {
        setUpdating((s) => {
          const n = new Set(s);
          n.delete(itemId);
          return n;
        });
      }
    },
    [session.id, onUpdate, queryClient, t]
  );

  // Stable callback wrapper for CullResultCard — avoids stale closures when
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
        queryClient.invalidateQueries({
          queryKey: ["photos"],
          refetchType: "active",
        });
        setSelected(new Set());
        onUpdate?.();
      } catch (err) {
        console.error("[handleBatchStatusChange] failed:", err);
        toast.error(t("cullActionFailed"));
      } finally {
        setUpdating(new Set());
      }
    },
    [session.id, sorted, selected, onUpdate, queryClient, t]
  );

  const handleTopNApply = useCallback(async () => {
    const n = Number.parseInt(topN, 10);
    if (isNaN(n) || n < 1 || n > rankedForTopN.length) {
      return;
    }
    // In duel mode, pick from top of sorted list; in curate mode, pick pending first then rejected
    const pool = isDuel
      ? rankedForTopN.slice(0, n).filter((i) => i.status !== "kept")
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
      setTopN("");
      setTopNConfirmOpen(false);
      onUpdate?.();
    } catch (err) {
      console.error("[handleTopNApply] failed:", err);
      toast.error(t("cullActionFailed"));
    } finally {
      setUpdating(new Set());
    }
  }, [session.id, sorted, rankedForTopN, topN, isDuel, onUpdate, t]);

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
      queryClient.invalidateQueries({
        queryKey: ["photos"],
        refetchType: "active",
      });
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      onUpdate?.();
    } catch (err) {
      console.error("[handleTrashRejected] failed:", err);
    } finally {
      setDeleting(false);
    }
  }, [rejected, t, onUpdate, queryClient]);

  const handleUndo = useCallback(async () => {
    try {
      const result = (await ipc.client.cull.undoLastAction({
        sessionId: session.id,
      })) as { reason?: string; success: boolean };
      if (!result.success) {
        toast.info(result.reason ?? t("cullNothingToUndo"));
        return;
      }
      queryClient.invalidateQueries({
        queryKey: ["photos"],
        refetchType: "active",
      });
      onUpdate?.();
    } catch (error) {
      console.error("[CullResult] undo failed:", error);
      toast.error(t("cullActionFailed"));
    }
  }, [onUpdate, queryClient, session.id, t]);

  // ── Render ──

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      {/* Summary bar — stats row */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-border border-b px-3 py-1.5 sm:px-4">
        <span className="min-w-0 text-[12px] text-muted-foreground">
          {t("cullResultsSummary", {
            total,
            kept: kept.length,
            rejected: rejected.length,
            pending: pending.length,
          })}
        </span>
        <span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2 max-[900px]:ml-0 max-[900px]:w-full max-[900px]:justify-start">
          <FilterDropdown
            ariaLabel={t("cullFilterStatus")}
            onChange={(value) => {
              setStatusFilter(value as typeof statusFilter);
              setSelected(new Set());
            }}
            options={[
              { label: t("cullFilterAll"), value: "all" },
              { label: t("cullKeep"), value: "kept" },
              { label: t("cullBatchPending"), value: "pending" },
              { label: t("cullReject"), value: "rejected" },
            ]}
            placeholder={t("cullFilterStatus")}
            value={statusFilter}
          />
          <FilterDropdown
            ariaLabel={t("cullResultSort")}
            onChange={(value) => setResultSort(value as typeof resultSort)}
            options={[
              {
                label: t(isDuel ? "cullSortByRating" : "cullSortDefault"),
                value: "default",
              },
              { label: t("cullSortDateAsc"), value: "dateAsc" },
              { label: t("cullSortDateDesc"), value: "dateDesc" },
            ]}
            placeholder={t("cullResultSort")}
            value={resultSort}
          />
          <button
            aria-pressed={favoriteOnly}
            className={`shrink-0 whitespace-nowrap rounded-[4px] px-1.5 py-0.5 text-[10px] transition-colors ${
              favoriteOnly
                ? "bg-amber-500/15 text-amber-500"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => {
              setFavoriteOnly((value) => !value);
              setSelected(new Set());
            }}
            type="button"
          >
            <Star className="mr-1 inline h-3 w-3" />
            {t("favorites")}
          </button>
          <button
            aria-label={t("cullUndo")}
            className="shrink-0 whitespace-nowrap rounded-[4px] px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
            onClick={handleUndo}
            type="button"
          >
            <Undo2 className="mr-1 inline h-3 w-3" />
            {t("cullUndo")}
          </button>
          {/* Top N is meaningful only for Elo-ranked duel sessions. */}
          {isDuel && (
            <input
              className="w-16 shrink-0 rounded-[4px] border border-input bg-transparent px-1.5 py-0.5 text-center text-[11px] text-foreground outline-none focus:border-primary"
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
          )}
          {isDuel && (
            <button
              className="shrink-0 whitespace-nowrap rounded-[4px] bg-primary/10 px-2 py-0.5 text-[10px] text-primary transition-colors hover:bg-primary/20 disabled:opacity-40"
              disabled={!topN || isNaN(Number.parseInt(topN, 10))}
              onClick={() => setTopNConfirmOpen(true)}
            >
              {t("cullTopNApply", { n: Number.parseInt(topN, 10) || 0 })}
            </button>
          )}
          <span className="h-3 w-px bg-border/50" />
          <button
            className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[4px] px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
            disabled={kept.length === 0}
            onClick={() => {
              setExportIds(kept.map((i) => i.photo.id));
              setExportOpen(true);
            }}
          >
            <Download className="h-3 w-3" />
            {t("cullExportKept")}
          </button>
          <button
            className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[4px] px-1.5 py-0.5 text-[10px] text-destructive transition-colors hover:bg-destructive/5 disabled:opacity-40"
            disabled={rejected.length === 0 || deleting}
            onClick={() => setTrashConfirmOpen(true)}
          >
            <Trash2 className="h-3 w-3" />
            {t("cullTrashRejected")}
          </button>
          <button
            className="shrink-0 whitespace-nowrap rounded-[4px] px-1.5 py-0.5 text-[10px] text-muted-foreground/50 transition-colors hover:text-foreground"
            onClick={toggleSelectAll}
          >
            {selected.size > 0 && selected.size === visibleItems.length
              ? t("cullDeselectAll")
              : t("cullSelectAll")}
          </button>
          <button
            className="rounded-[4px] p-1 text-muted-foreground/50 transition-colors hover:text-foreground"
            onClick={() =>
              setViewMode((v) => (v === "gallery" ? "list" : "gallery"))
            }
          >
            {viewMode === "gallery" ? (
              <LayoutList className="h-3.5 w-3.5" />
            ) : (
              <LayoutGrid className="h-3.5 w-3.5" />
            )}
          </button>
        </span>
      </div>

      {/* Batch action bar (when items selected) */}
      {selected.size > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-border border-b bg-primary/[0.03] px-3 py-1.5 sm:px-6">
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {t("photosSelected", { count: selected.size })}
          </span>
          <button
            className="shrink-0 whitespace-nowrap rounded-[4px] bg-success/10 px-2 py-0.5 text-[10px] text-success transition-colors hover:bg-success/20"
            onClick={() => handleBatchStatusChange("kept")}
          >
            <Heart className="mr-1 inline h-3 w-3" />
            {t("cullBatchKeep")}
          </button>
          <button
            className="shrink-0 whitespace-nowrap rounded-[4px] bg-destructive/10 px-2 py-0.5 text-[10px] text-destructive transition-colors hover:bg-destructive/20"
            onClick={() => handleBatchStatusChange("rejected")}
          >
            <Trash2 className="mr-1 inline h-3 w-3" />
            {t("cullBatchReject")}
          </button>
          <button
            className="shrink-0 whitespace-nowrap rounded-[4px] bg-muted px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => handleBatchStatusChange("pending")}
          >
            ↺ {t("cullBatchPending")}
          </button>
          <span className="h-3 w-px bg-border" />
          <button
            className="shrink-0 whitespace-nowrap rounded-[4px] px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => {
              setExportIds(selectedIds);
              setExportOpen(true);
            }}
          >
            <Download className="mr-1 inline h-3 w-3" />
            {t("cullExportSelected")}
          </button>
          <button
            className="shrink-0 whitespace-nowrap rounded-[4px] px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
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

      {/* Gallery grid */}
      {viewMode === "gallery" ? (
        <div
          className="relative min-h-0 min-w-0 flex-1 select-none overflow-y-auto p-2 sm:p-4"
          onMouseDown={handleMarqueeStart}
          ref={containerRef}
        >
          {visibleItems.length === 0 ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              {t("cullNoPhotosInSession")}
            </div>
          ) : (
            <div
              style={{
                height: galleryVirtualizer.getTotalSize(),
                position: "relative",
              }}
            >
              {galleryVirtualizer.getVirtualItems().map((virtualRow) => {
                const start = virtualRow.index * galleryColumns;
                const rowItems = visibleItems.slice(
                  start,
                  start + galleryColumns
                );
                return (
                  <div
                    data-index={virtualRow.index}
                    key={virtualRow.key}
                    ref={galleryVirtualizer.measureElement}
                    style={{
                      display: "grid",
                      gap: 12,
                      gridTemplateColumns: `repeat(${galleryColumns}, minmax(0, 1fr))`,
                      left: 0,
                      paddingBottom: 12,
                      position: "absolute",
                      top: 0,
                      transform: `translateY(${virtualRow.start}px)`,
                      width: "100%",
                    }}
                  >
                    {rowItems.map((item, offset) => {
                      const index = start + offset;
                      return (
                        <CullResultCard
                          index={index}
                          isDuel={isDuel}
                          isSelected={selected.has(item.id)}
                          item={item}
                          key={item.id}
                          onPreview={setLightboxIndex}
                          onSelect={handleCardSelect}
                          onStatusChange={stableHandleStatusChange}
                          updating={updating}
                        />
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
          {/* Marquee selection overlay */}
          {marquee && (
            <div
              className="pointer-events-none absolute z-30 rounded-[2px] border border-primary/40 bg-primary/10"
              style={{
                left: Math.min(marquee.startX, marquee.x),
                top: Math.min(marquee.startY, marquee.y),
                width: Math.abs(marquee.x - marquee.startX),
                height: Math.abs(marquee.y - marquee.startY),
              }}
            />
          )}
        </div>
      ) : (
        /* ── Original list view ── */
        <div
          className="min-h-0 min-w-0 flex-1 overflow-y-auto p-2 sm:p-6"
          ref={containerRef}
        >
          {visibleItems.length === 0 ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              {t("cullNoPhotosInSession")}
            </div>
          ) : (
            <div
              style={{
                height: virtualizer.getTotalSize(),
                position: "relative",
              }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const item = visibleItems[virtualRow.index];
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
                    }}
                  >
                    <CullResultRow
                      index={virtualRow.index}
                      isDuel={isDuel}
                      isSelected={selected.has(item.id)}
                      item={item}
                      onPreview={setLightboxIndex}
                      onSelect={handleCardSelect}
                      onStatusChange={stableHandleStatusChange}
                      updating={updating}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Top N confirm dialog */}
      {topNConfirmOpen && (
        <Dialog onOpenChange={setTopNConfirmOpen} open={topNConfirmOpen}>
          <DialogContent className="max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-[360px] overflow-y-auto">
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
          <DialogContent className="max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-[360px] overflow-y-auto">
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
        elevated={lightboxIndex >= 0}
        onClose={() => setAlbumOpen(false)}
        open={albumOpen}
        photoIds={albumIds}
      />

      {/* Lightbox */}
      <PhotoLightbox
        initialIndex={lightboxIndex}
        modalOpen={albumOpen}
        onAddToAlbum={(photoId) => {
          setAlbumIds([photoId]);
          setAlbumOpen(true);
        }}
        onClose={() => setLightboxIndex(-1)}
        onToggleFavorite={async (photoId, nextFavorite) => {
          await ipc.client.photos.toggleFavorite({
            ids: [photoId],
            favorite: nextFavorite,
          });
          queryClient.invalidateQueries({
            queryKey: ["photos"],
            refetchType: "active",
          });
          onUpdate?.();
        }}
        open={lightboxIndex >= 0}
        photos={lightboxPhotos}
      />
    </div>
  );
}
