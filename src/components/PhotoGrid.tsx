import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PhotoCard } from "./PhotoCard";
import { Skeleton } from "./ui/skeleton";

interface Photo {
  filename: string;
  fileSize: number;
  height: number;
  id: number;
  isIndexed: boolean;
  path: string;
  thumbnailPath: string | null;
  width: number;
}
interface PhotoGridProps {
  loading: boolean;
  onContextMenu: (e: React.MouseEvent) => void;
  onConvertSelected?: () => void;
  onDeleteSelected?: () => void;
  onDoubleClick: (id: number) => void;
  onExportSelected?: () => void;
  onRenameSelected?: () => void;
  onSelect: (id: number, event: React.MouseEvent) => void;
  photos: Photo[];
  searchQuery?: string;
  selectedIds: Set<number>;
}

const DENSITY_CONFIGS = [
  { label: "小", targetColWidth: 160 },
  { label: "中", targetColWidth: 220 },
  { label: "大", targetColWidth: 280 },
];

const MIN_COLUMNS = 2;
const BATCH_SIZE = 120;
const GAP = 8;
const PRELOAD_MARGIN = "1000px"; // ~3 screens ahead for smooth scrolling

function distributePhotos(photos: Photo[], columnCount: number): Photo[][] {
  const columns: Photo[][] = Array.from({ length: columnCount }, () => []);
  const heights: number[] = new Array(columnCount).fill(0);

  for (const photo of photos) {
    const shortestCol = heights.indexOf(Math.min(...heights));
    const ar = photo.width && photo.height ? photo.width / photo.height : 4 / 3;
    columns[shortestCol].push(photo);
    heights[shortestCol] += 1 / ar;
  }

  return columns;
}

export function PhotoGrid({
  photos,
  loading,
  selectedIds,
  searchQuery,
  onSelect,
  onDoubleClick,
  onContextMenu,
  onConvertSelected,
  onDeleteSelected,
  onExportSelected,
  onRenameSelected,
}: PhotoGridProps) {
  const { t } = useTranslation();
  const [densityIdx, setDensityIdx] = useState(1); // default "中" / 220px
  const [columnCount, setColumnCount] = useState(4);
  const [compact, setCompact] = useState(false);
  const [visibleCount, setVisibleCount] = useState(BATCH_SIZE);
  const containerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const lastScrollY = useRef(0);
  const targetColWidth = DENSITY_CONFIGS[densityIdx].targetColWidth;

  // Responsive columns via ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      const cols = Math.max(MIN_COLUMNS, Math.floor(width / targetColWidth));
      setColumnCount(cols);
      setCompact(width < 500);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [targetColWidth]);

  // Progressive render
  useEffect(() => {
    setVisibleCount(BATCH_SIZE);
  }, []);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) {
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisibleCount((prev) => Math.min(prev + BATCH_SIZE, photos.length));
        }
      },
      { rootMargin: PRELOAD_MARGIN }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [photos.length]);

  const visiblePhotos = useMemo(
    () => photos.slice(0, visibleCount),
    [photos, visibleCount]
  );

  const columns = useMemo(
    () => distributePhotos(visiblePhotos, columnCount),
    [visiblePhotos, columnCount]
  );

  // Skeleton: mimic a range of aspect ratios
  const skeletonAspects = useCallback(
    () => [3 / 4, 4 / 3, 1 / 1, 3 / 2, 2 / 3],
    []
  );

  if (loading && photos.length === 0) {
    const skelCols = Array.from({ length: columnCount }, (_, ci) =>
      Array.from({ length: 3 }, (_, ri) => ci * 3 + ri)
    );
    return (
      <div className="flex flex-1 flex-col">
        <div className="flex items-center justify-between border-border border-b px-4 py-2">
          <Skeleton className="h-4 w-24 bg-card" />
          <div className="flex items-center gap-1">
            {DENSITY_CONFIGS.map((cfg) => (
              <Skeleton
                className="h-5 w-6 rounded-[4px] bg-card"
                key={cfg.label}
              />
            ))}
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
          {selectedIds.size > 0 && onRenameSelected && (
            <button
              className="rounded-[4px] px-2 py-1 text-foreground text-[11px] transition-colors hover:bg-white/5"
              onClick={onRenameSelected}
            >
              {compact ? "重命名" : `重命名 (${selectedIds.size})`}
            </button>
          )}
          {selectedIds.size > 0 && onConvertSelected && (
            <button
              className="rounded-[4px] px-2 py-1 text-foreground text-[11px] transition-colors hover:bg-white/5"
              onClick={onConvertSelected}
            >
              {compact ? "转换" : `格式转换 (${selectedIds.size})`}
            </button>
          )}
          {selectedIds.size > 0 && onExportSelected && (
            <button
              className="rounded-[4px] px-2 py-1 text-foreground text-[11px] transition-colors hover:bg-white/5"
              onClick={onExportSelected}
            >
              {compact ? "导出" : `导出选中 (${selectedIds.size})`}
            </button>
          )}
          {selectedIds.size > 0 && onDeleteSelected && (
            <button
              className="rounded-[4px] px-2 py-1 text-[#e5484d] text-[11px] transition-colors hover:bg-[#e5484d]/10"
              onClick={onDeleteSelected}
            >
              {compact
                ? `-${selectedIds.size}`
                : `删除选中 (${selectedIds.size})`}
            </button>
          )}
          {!compact && (
            <div className="flex items-center gap-1">
              {DENSITY_CONFIGS.map((cfg, i) => (
                <button
                  className={`rounded-[4px] px-2 py-1 text-[11px] transition-colors ${
                    i === densityIdx
                      ? "bg-primary/20 text-primary"
                      : "text-muted-foreground hover:bg-white/5 hover:text-foreground"
                  }`}
                  key={cfg.label}
                  onClick={() => setDensityIdx(i)}
                >
                  {cfg.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Masonry grid — JS shortest-column-first, each column is a flex-col */}
      <div
        className="flex-1 overflow-y-auto px-2 pt-2"
        onContextMenu={onContextMenu}
        ref={containerRef}
      >
        <div className="flex gap-2" style={{ gap: GAP }}>
          {columns.map((col, ci) => (
            <div className="flex flex-1 flex-col" key={ci} style={{ gap: GAP }}>
              {col.map((photo) => (
                <PhotoCard
                  filename={photo.filename}
                  height={photo.height}
                  id={photo.id}
                  isSelected={selectedIds.has(photo.id)}
                  key={photo.id}
                  onClick={onSelect}
                  onDoubleClick={onDoubleClick}
                  path={photo.path}
                  searchQuery={searchQuery}
                  thumbnailPath={photo.thumbnailPath}
                  width={photo.width}
                />
              ))}
            </div>
          ))}
        </div>

        {/* Sentinel for progressive loading */}
        {visibleCount < photos.length && (
          <div
            className="flex h-12 items-center justify-center py-4"
            ref={sentinelRef}
          >
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        )}
      </div>

      {/* Loading overlay for subsequent loads */}
      {loading && photos.length > 0 && (
        <div className="pointer-events-none absolute top-[41px] right-0 bottom-0 left-0 flex items-start justify-center bg-background/30 pt-4">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      )}
    </div>
  );
}
