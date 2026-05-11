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
const PRELOAD_MARGIN = "1000px";
const VIEWPORT_CULL_RATIO = 3; // unload items scrolled >3 viewports above

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

function useViewportCull(
  containerRef: React.RefObject<HTMLDivElement | null>,
  photoCount: number,
  columnCount: number,
  targetColWidth: number,
): { startIdx: number; endIdx: number } {
  const [startIdx, setStartIdx] = useState(0);
  const [endIdx, setEndIdx] = useState(BATCH_SIZE);
  const scrollRAF = useRef(0);

  useEffect(() => {
    setEndIdx(Math.min(BATCH_SIZE, photoCount));
    setStartIdx(0);
  }, [photoCount]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    function onScroll() {
      if (scrollRAF.current) cancelAnimationFrame(scrollRAF.current);
      scrollRAF.current = requestAnimationFrame(() => {
        if (!el) return;
        const viewH = el.clientHeight;
        const scrollTop = el.scrollTop;
        const cullThreshold = viewH * VIEWPORT_CULL_RATIO;
        const approxRowH = targetColWidth * 0.75; // ~4:3 avg aspect
        const itemsPerRow = columnCount;
        const visibleRows = Math.ceil(viewH / approxRowH) + 2;
        const topRows = Math.max(0, Math.floor(scrollTop / approxRowH) - visibleRows);
        const newStart = Math.max(0, topRows * itemsPerRow - itemsPerRow);
        const newEnd = Math.min(photoCount, (topRows + visibleRows * VIEWPORT_CULL_RATIO) * itemsPerRow + itemsPerRow);

        // Only update if significant change (>1 row)
        if (Math.abs(newStart - startIdx) > itemsPerRow || Math.abs(newEnd - endIdx) > itemsPerRow * 2) {
          setStartIdx(Math.max(0, newStart));
          setEndIdx(Math.min(photoCount, Math.max(newEnd, BATCH_SIZE)));
        }
      });
    }

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (scrollRAF.current) cancelAnimationFrame(scrollRAF.current);
    };
  }, [containerRef, photoCount, columnCount, targetColWidth, startIdx, endIdx]);

  return { startIdx, endIdx };
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
  const containerRef = useRef<HTMLDivElement>(null);
  const targetColWidth = DENSITY_CONFIGS[densityIdx].targetColWidth;

  // Responsive columns via ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      const cols = Math.max(MIN_COLUMNS, Math.floor(width / targetColWidth));
      setColumnCount(cols);
      setCompact(width < 500);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [targetColWidth]);

  // Viewport-culled windowing: keeps DOM bounded regardless of photo count.
  const { startIdx, endIdx } = useViewportCull(
    containerRef as React.RefObject<HTMLDivElement>,
    photos.length,
    columnCount,
    targetColWidth,
  );

  const visiblePhotos = useMemo(
    () => photos.slice(startIdx, endIdx),
    [photos, startIdx, endIdx]
  );

  // Spacer heights to maintain scrollbar accuracy
  const topSpacerHeight = useMemo(() => {
    if (startIdx === 0) return 0;
    const estCardH = targetColWidth * 1.33; // ~4:3 avg aspect
    const itemsPerRow = columnCount;
    return Math.floor(startIdx / itemsPerRow) * estCardH;
  }, [startIdx, columnCount, targetColWidth]);

  const bottomSpacerHeight = useMemo(() => {
    const remaining = photos.length - endIdx;
    if (remaining <= 0) return 0;
    const estCardH = targetColWidth * 1.33;
    const itemsPerRow = columnCount;
    return Math.ceil(remaining / itemsPerRow) * estCardH;
  }, [endIdx, photos.length, columnCount, targetColWidth]);

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

      {/* Masonry grid — viewport-culled windowed rendering */}
      <div
        className="flex-1 overflow-y-auto px-2 pt-2"
        onContextMenu={onContextMenu}
        ref={containerRef}
      >
        {/* Top spacer: maintains scroll position for culled items */}
        {topSpacerHeight > 0 && <div style={{ height: topSpacerHeight }} />}

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

        {/* Bottom spacer: maintains scrollbar for items below viewport */}
        {bottomSpacerHeight > 0 && <div style={{ height: bottomSpacerHeight }} />}
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
