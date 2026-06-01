import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { GroupHeader } from "./MasonryGrid";
import { MasonryGrid } from "./MasonryGrid";
import { PhotoCard } from "./PhotoCard";
import { SortDropdown } from "./SortDropdown";
import { Skeleton } from "./ui/skeleton";

interface Photo {
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
  loading: boolean;
  onContextMenu: (e: React.MouseEvent) => void;
  onDoubleClick: (id: number) => void;
  onEndReached?: () => void;
  onKeyboardSelect?: (id: number) => void;
  onMarqueeSelect?: (ids: Set<number>) => void;
  onSelect: (id: number, event: React.MouseEvent) => void;
  onSortChange?: (sort: SortField, order: SortOrder) => void;
  onToggleFavorite?: (id: number) => void;
  photos: Photo[];
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

export function PhotoGrid({
  photos,
  loading,
  selectedIds,
  deletingIds,
  searchQuery,
  sort = "date",
  sortOrder = "desc",
  emptyState,
  onSelect,
  onDoubleClick,
  onContextMenu,
  onEndReached,
  onSortChange,
  onToggleFavorite,
  onKeyboardSelect,
  onMarqueeSelect,
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
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;

  const containerCallbackRef = useCallback((node: HTMLDivElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    containerRef.current = node;
    if (!node) {
      return;
    }
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
        deleting={deletingIds?.has(photo.id)}
        filename={photo.filename}
        getDragIds={getDragIds}
        height={photo.height}
        id={photo.id}
        isFavorite={photo.isFavorite}
        isSelected={selectedIds.has(photo.id)}
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
    [
      selectedIds,
      deletingIds,
      onSelect,
      onDoubleClick,
      onToggleFavorite,
      searchQuery,
      getDragIds,
    ]
  );

  const masonryItems = useMemo(() => photos, [photos]);

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
    return (
      <div className="flex flex-1 flex-col">
        <div className="flex items-center justify-between border-border border-b px-4 py-2">
          <span className="truncate text-[12px] text-muted-foreground">
            {t("photosCount", { count: 0 })}
          </span>
        </div>
        <div className="flex flex-1 items-center justify-center">
          {emptyState ?? (
            <span className="text-[13px] text-muted-foreground/70">
              {t("noPhotos")}
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-border border-b px-4 py-2">
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
          className="scrollbar-thin px-2 pt-2"
          columnCount={columnCount}
          containerWidth={containerWidth - 16}
          gap={GAP}
          groupHeaders={groupHeaders}
          items={masonryItems}
          onEndReached={onEndReached}
          onMarqueeSelect={onMarqueeSelect}
          renderItem={renderItem}
          scrollToId={scrollToId}
          selectionActive={selectedIds.size > 0}
        />
      </div>

      {/* Loading overlay */}
      {loading && photos.length > 0 && (
        <div className="pointer-events-none absolute top-[41px] right-0 bottom-0 left-0 flex items-start justify-center bg-background/30 pt-4">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      )}
    </div>
  );
}
