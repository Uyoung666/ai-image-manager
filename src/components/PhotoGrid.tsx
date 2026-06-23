import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { GroupHeader, MasonryGridHandle } from "./MasonryGrid";
import { MasonryGrid } from "./MasonryGrid";
import { PhotoCard } from "./PhotoCard";
import { SortDropdown } from "./SortDropdown";
import { Skeleton } from "./ui/skeleton";

interface Photo {
  dominantColors?: string | null;
  fileDate?: number | null;
  filename: string;
  fileSize: number;
  height: number;
  id: number;
  isFavorite?: boolean;
  isIndexed: boolean;
  path: string;
  similarity?: number;
  thumbnailPath: string | null;
  width: number;
}
export type SortField = "date" | "name" | "size";
export type SortOrder = "asc" | "desc";

interface PhotoGridProps {
  deletingIds?: Set<number>;
  emptyState?: React.ReactNode;
  error?: string;
  /** MasonryGrid 命令式 ref，用于原子化滚动定位 */
  gridRef?: React.RefObject<MasonryGridHandle | null>;
  /** 是否还有更多数据可加载（对应 infinite scroll 的 hasNextPage） */
  hasMore?: boolean;
  /** 正在加载更多数据（useInfiniteQuery 的 isFetchingNextPage） */
  isLoadingMore?: boolean;
  /**
   * 是否为占位数据（keepPreviousData 期间的旧缓存）。
   * 为 true 时 MasonryGrid 会锁死滚动恢复和锚点调整，
   * 避免基于假数据做错误定位。
   */
  isPlaceholderData?: boolean;
  loading: boolean;
  onBackgroundClick?: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDoubleClick: (id: number) => void;
  onEndReached?: () => void;
  onKeyboardSelect?: (id: number) => void;
  onMarqueeSelect?: (ids: Set<number>) => void;
  onSelect: (id: number, event: React.MouseEvent) => void;
  onSortChange?: (sort: SortField, order: SortOrder) => void;
  onToggleFavorite?: (id: number) => void;
  photos: Photo[];
  /**
   * 路由唯一标识，用于区分不同页面的滚动位置
   * 例如: "home" | "album-123" | "person-456"
   */
  routeKey: string;
  searchQuery?: string;
  selectedIds: Set<number>;
  sort?: SortField;
  sortOrder?: SortOrder;
}

const MIN_COLUMNS = 2;
const COL_WIDTH_MIN = 140;
const COL_WIDTH_MAX = 320;
const COL_WIDTH_DEFAULT = 220;
const GAP = 8;

const GRID_COL_WIDTH_KEY = "grid_column_width";

function loadColWidth(): number {
  try {
    const raw = localStorage.getItem(GRID_COL_WIDTH_KEY);
    if (raw !== null) {
      const val = Number(raw);
      if (!Number.isNaN(val) && val >= COL_WIDTH_MIN && val <= COL_WIDTH_MAX) {
        return val;
      }
    }
  } catch {
    /* ignore */
  }
  return COL_WIDTH_DEFAULT;
}

export const PhotoGrid = memo(function PhotoGrid({
  photos,
  loading,
  isLoadingMore = false,
  selectedIds,
  deletingIds,
  gridRef,
  routeKey,
  searchQuery,
  sort = "date",
  sortOrder = "desc",
  emptyState,
  error,
  isPlaceholderData = false,
  onSelect,
  onDoubleClick,
  onContextMenu,
  onEndReached,
  hasMore = false,
  onSortChange,
  onToggleFavorite,
  onKeyboardSelect,
  onMarqueeSelect,
  onBackgroundClick,
}: PhotoGridProps) {
  const { t, i18n } = useTranslation();
  const [targetColWidth, setTargetColWidth] = useState(loadColWidth);
  const [columnCount, setColumnCount] = useState(4);
  const [compact, setCompact] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const targetColWidthRef = useRef(targetColWidth);
  targetColWidthRef.current = targetColWidth;
  // selectedIds/deletingIds 通过 ref 传递，稳定 renderItem 引用。
  // 移除 deps 中的 Set 依赖 → 选中操作仅触发实际变化卡片的 memo 比较。
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const deletingIdsRef = useRef(deletingIds);
  deletingIdsRef.current = deletingIds;

  const containerCallbackRef = useCallback((node: HTMLDivElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    containerRef.current = node;
    if (!node) {
      return;
    }
    // Set initial width synchronously so MasonryGrid never renders with
    // containerWidth=0 (avoids a blank first frame while waiting for the
    // async ResizeObserver callback).
    const w = node.clientWidth;
    setContainerWidth(w);
    setColumnCount(
      Math.max(MIN_COLUMNS, Math.floor(w / targetColWidthRef.current))
    );
    setCompact(w < 500);
    // ResizeObserver for subsequent size changes.
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      setContainerWidth(width);
      const cols = Math.max(
        MIN_COLUMNS,
        Math.floor(width / targetColWidthRef.current)
      );
      setColumnCount(cols);
      setCompact(width < 500);
    });
    observer.observe(node);
    observerRef.current = observer;
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) {
      return;
    }
    const cols = Math.max(
      MIN_COLUMNS,
      Math.floor(containerWidth / targetColWidth)
    );
    setColumnCount(cols);
  }, [targetColWidth, containerWidth]);

  // Track the single selected photo id for scroll-to behavior
  const scrollToId = useMemo(() => {
    if (selectedIds.size === 1) {
      return [...selectedIds][0];
    }
    return null;
  }, [selectedIds]);

  // Keyboard navigation (arrow keys)
  useEffect(() => {
    if (!onKeyboardSelect || photos.length === 0) {
      return;
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      const arrows = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
      if (!arrows.includes(e.key)) {
        return;
      }

      e.preventDefault();
      const currentId = selectedIds.size === 1 ? [...selectedIds][0] : null;
      let currentIdx = currentId
        ? photos.findIndex((p) => p.id === currentId)
        : -1;
      if (currentIdx < 0) {
        currentIdx = 0;
      }

      let nextIdx = currentIdx;
      if (e.key === "ArrowRight") {
        nextIdx = Math.min(photos.length - 1, currentIdx + 1);
      } else if (e.key === "ArrowLeft") {
        nextIdx = Math.max(0, currentIdx - 1);
      } else if (e.key === "ArrowDown") {
        nextIdx = Math.min(photos.length - 1, currentIdx + columnCount);
      } else if (e.key === "ArrowUp") {
        nextIdx = Math.max(0, currentIdx - columnCount);
      }

      if (nextIdx !== currentIdx || currentId === null) {
        onKeyboardSelect!(photos[nextIdx].id);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [photos, selectedIds, columnCount, onKeyboardSelect]);

  const skeletonAspects = useCallback(
    () => [3 / 4, 4 / 3, 1 / 1, 3 / 2, 2 / 3],
    []
  );

  const getDragIds = useCallback((id: number) => {
    const current = selectedIdsRef.current;
    return current.has(id) ? [...current] : [id];
  }, []);

  const renderItem = useCallback(
    (photo: Photo) => (
      <PhotoCard
        deleting={deletingIdsRef.current?.has(photo.id)}
        dominantColors={photo.dominantColors}
        filename={photo.filename}
        getDragIds={getDragIds}
        height={photo.height}
        id={photo.id}
        isFavorite={photo.isFavorite}
        isSelected={selectedIdsRef.current.has(photo.id)}
        onClick={onSelect}
        onDoubleClick={onDoubleClick}
        onToggleFavorite={onToggleFavorite}
        path={photo.path}
        searchQuery={searchQuery}
        similarity={photo.similarity}
        thumbnailPath={photo.thumbnailPath}
        width={photo.width}
      />
    ),
    [onSelect, onDoubleClick, onToggleFavorite, searchQuery, getDragIds]
  );

  const groupHeaders = useMemo((): GroupHeader[] => {
    if (sort !== "date" || photos.length === 0) {
      return [];
    }
    const headers: GroupHeader[] = [];
    let lastKey = "";
    const dtf = new Intl.DateTimeFormat(i18n.language, {
      year: "numeric",
      month: "long",
    });
    for (let i = 0; i < photos.length; i++) {
      const ts = photos[i].fileDate;
      if (!ts) {
        continue;
      }
      const d = new Date(ts);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      if (key !== lastKey) {
        lastKey = key;
        headers.push({
          beforeIndex: i,
          label: dtf.format(d),
        });
      }
    }
    return headers;
  }, [photos, sort, i18n.language]);

  if (loading && photos.length === 0) {
    const skelCols = Array.from({ length: columnCount }, (_, ci) =>
      Array.from({ length: 3 }, (_, ri) => ci * 3 + ri)
    );
    return (
      <div className="flex flex-1 flex-col">
        <div className="flex items-center justify-between border-border border-b px-4 py-2">
          <Skeleton className="h-4 w-24 bg-card" />
          <div className="flex items-center gap-1.5">
            <Skeleton className="h-2.5 w-8 rounded-[2px] bg-card" />
            <Skeleton className="h-4 w-20 rounded-[4px] bg-card" />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pt-2">
          <div className="flex gap-2">
            {skelCols.map((items, ci) => (
              <div className="flex flex-1 flex-col gap-2" key={ci}>
                {items.map((i) => (
                  <Skeleton
                    className="w-full rounded-[8px] bg-muted"
                    key={i}
                    style={{
                      aspectRatio:
                        skeletonAspects()[i % skeletonAspects().length],
                    }}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!loading && photos.length === 0) {
    const isError = !!error;
    return (
      <div className="flex flex-1 flex-col">
        <div className="flex items-center justify-between border-border border-b px-4 py-2">
          <span className="truncate text-[12px] text-muted-foreground">
            {t("photosCount", { count: 0 })}
          </span>
        </div>
        <div className="flex flex-1 items-center justify-center">
          {isError ? (
            <div className="flex flex-col items-center gap-3 px-6 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-danger/10">
                <svg
                  aria-hidden="true"
                  className="h-5 w-5 text-danger"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  viewBox="0 0 24 24"
                >
                  <path
                    d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <p className="text-[13px] text-muted-foreground/70">{error}</p>
            </div>
          ) : (
            (emptyState ?? (
              <span className="text-[13px] text-muted-foreground/70">
                {t("noPhotos")}
              </span>
            ))
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex flex-1 flex-col relative"
      onClick={(e) => {
        if (onBackgroundClick) {
          const target = e.target as HTMLElement;
          // 只有点击非照片卡片区域才触发背景点击
          if (!target.closest("[data-photo-id]")) {
            onBackgroundClick();
          }
        }
      }}
    >
      {/* Floating glass toolbar — 悬浮毛玻璃工具条 */}
      <div
        className="absolute top-0 left-0 right-0 z-50 flex items-center justify-between border-border border-b glass-surface px-4 py-2"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="truncate text-[12px] text-muted-foreground">
          {t("photosCount", { count: photos.length.toLocaleString() })}
          {selectedIds.size > 0 &&
            t("photosSelected", { count: selectedIds.size })}
        </span>
        <div className="flex items-center gap-2">
          {!compact && onSortChange && (
            <SortDropdown
              onChange={onSortChange}
              order={sortOrder}
              sort={sort}
            />
          )}
          {!compact && (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-muted-foreground/70">
                {t("gridSize")}
              </span>
              <input
                className="h-4 w-20 cursor-pointer accent-primary"
                max={COL_WIDTH_MAX}
                min={COL_WIDTH_MIN}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setTargetColWidth(val);
                  try {
                    localStorage.setItem(GRID_COL_WIDTH_KEY, String(val));
                  } catch {
                    /* ignore */
                  }
                }}
                step={10}
                type="range"
                value={targetColWidth}
              />
            </div>
          )}
        </div>
      </div>

      {/* Masonry grid */}
      <div
        className="min-h-0 flex-1"
        onContextMenu={onContextMenu}
        ref={containerCallbackRef}
      >
        <MasonryGrid
          className="scrollbar-thin px-2 pt-12 pb-7"
          columnCount={columnCount}
          containerWidth={containerWidth - 16}
          gap={GAP}
          groupHeaders={groupHeaders}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          isPlaceholderData={isPlaceholderData}
          items={photos}
          onEndReached={onEndReached}
          onMarqueeSelect={onMarqueeSelect}
          ref={gridRef}
          renderItem={renderItem}
          routeKey={routeKey}
          scrollToId={scrollToId}
          selectionActive={selectedIds.size > 0}
        />
      </div>

      {/* Loading overlay */}
      {loading && photos.length > 0 && (
        <div className="pointer-events-none absolute top-0 right-0 bottom-0 left-0 flex items-start justify-center bg-background/30 pt-4">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      )}
    </div>
  );
},
(prevProps, nextProps) => {
  if (prevProps.photos !== nextProps.photos) return false;
  if (prevProps.loading !== nextProps.loading) return false;
  if (prevProps.isLoadingMore !== nextProps.isLoadingMore) return false;
  if (prevProps.selectedIds !== nextProps.selectedIds) return false;
  if (prevProps.routeKey !== nextProps.routeKey) return false;
  if (prevProps.searchQuery !== nextProps.searchQuery) return false;
  if (prevProps.sort !== nextProps.sort) return false;
  if (prevProps.sortOrder !== nextProps.sortOrder) return false;
  if (prevProps.isPlaceholderData !== nextProps.isPlaceholderData) return false;
  if (prevProps.error !== nextProps.error) return false;
  if (prevProps.hasMore !== nextProps.hasMore) return false;
  return true;
});
