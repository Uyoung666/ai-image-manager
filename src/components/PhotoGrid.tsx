import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Virtuoso } from "react-virtuoso";
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
const GAP = 8;

// --- Waterfall distribution (masonry layout) ---
// Distributes photos into balanced columns using shortest-column-first placement.
// Applied once on the full dataset and memoized — react-virtuoso handles the
// viewport rendering so this only recomputes when photos or columnCount change.

function distributePhotos(photos: Photo[], columnCount: number): Photo[][] {
  const columns: Photo[][] = Array.from({ length: columnCount }, () => []);
  const heights: number[] = new Array(columnCount).fill(0);

  for (const photo of photos) {
    const shortestCol = heights.indexOf(Math.min(...heights));
    const ar =
      photo.width && photo.height ? photo.width / photo.height : 4 / 3;
    columns[shortestCol].push(photo);
    heights[shortestCol] += 1 / ar;
  }

  return columns;
}

function buildRows(columns: Photo[][], columnCount: number): (Photo | null)[][] {
  const maxRows = Math.max(...columns.map((c) => c.length), 0);
  const rows: (Photo | null)[][] = [];
  for (let r = 0; r < maxRows; r++) {
    const row: (Photo | null)[] = [];
    for (let c = 0; c < columnCount; c++) {
      row.push(columns[c][r] ?? null);
    }
    rows.push(row);
  }
  return rows;
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

  // --- Responsive column count via ResizeObserver ---
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

  // --- Build masonry rows from all photos (not just visible ones) ---
  const columns = useMemo(
    () => distributePhotos(photos, columnCount),
    [photos, columnCount]
  );

  const rows = useMemo(
    () => buildRows(columns, columnCount),
    [columns, columnCount]
  );

  // Pre-calculate row heights for accurate Virtuoso scroll estimation.
  // Without this, variable-height masonry rows cause visible gaps and
  // scrollbar jumps as Virtuoso re-measures after images load.
  const { defaultItemHeight } = useMemo(() => {
    if (!containerRef.current || rows.length === 0) {
      return { rowHeights: [] as number[], defaultItemHeight: 250 };
    }
    const cw = containerRef.current.clientWidth;
    const padX = 16; // px-2 * 2
    const colW =
      (cw - padX - (columnCount - 1) * GAP) / columnCount;
    const heights = rows.map((row) => {
      let maxH = 0;
      for (const photo of row) {
        if (!photo || !photo.width || !photo.height) continue;
        const ar = photo.width / photo.height;
        const h = colW / ar;
        if (h > maxH) maxH = h;
      }
      return maxH > 0 ? maxH + GAP : 220 + GAP;
    });
    const avg = heights.reduce((a, b) => a + b, 0) / heights.length;
    return { defaultItemHeight: Math.round(avg) };
  }, [rows, columnCount]);

  // --- Skeleton aspect ratios for loading state ---
  const skeletonAspects = useCallback(
    () => [3 / 4, 4 / 3, 1 / 1, 3 / 2, 2 / 3],
    []
  );

  // --- Skeleton screen ---
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

  // --- Empty state ---
  if (!loading && photos.length === 0) {
    return (
      <div className="flex flex-1 flex-col">
        <div className="flex items-center justify-between border-border border-b px-4 py-2">
          <span className="truncate text-[12px] text-muted-foreground">
            {t("photosCount", { count: 0 })}
          </span>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <span className="text-[13px] text-[#6b6b75]">
            {t("noPhotos")}
          </span>
        </div>
      </div>
    );
  }

  // --- Normal render with react-virtuoso ---
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
              className="rounded-[4px] px-2 py-1 text-foreground text-[11px] transition-colors hover:bg-foreground/5"
              onClick={onRenameSelected}
            >
              {compact ? "重命名" : `重命名 (${selectedIds.size})`}
            </button>
          )}
          {selectedIds.size > 0 && onConvertSelected && (
            <button
              className="rounded-[4px] px-2 py-1 text-foreground text-[11px] transition-colors hover:bg-foreground/5"
              onClick={onConvertSelected}
            >
              {compact ? "转换" : `格式转换 (${selectedIds.size})`}
            </button>
          )}
          {selectedIds.size > 0 && onExportSelected && (
            <button
              className="rounded-[4px] px-2 py-1 text-foreground text-[11px] transition-colors hover:bg-foreground/5"
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
                      : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
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

      {/* Virtual-scrolled masonry grid */}
      <div
        className="flex-1"
        onContextMenu={onContextMenu}
        ref={containerRef}
      >
        <Virtuoso
          className="scrollbar-thin"
          computeItemKey={(index) => index}
          defaultItemHeight={defaultItemHeight}
          increaseViewportBy={{ top: 400, bottom: 400 }}
          itemContent={(index) => {
            const row = rows[index];
            return (
              <div
                className="flex px-2"
                style={{ gap: GAP, paddingBottom: GAP }}
              >
                {row.map((photo, ci) => (
                  <div
                    className="flex-1"
                    key={photo?.id ?? `empty-${ci}`}
                  >
                    {photo && (
                      <PhotoCard
                        filename={photo.filename}
                        height={photo.height}
                        id={photo.id}
                        isSelected={selectedIds.has(photo.id)}
                        onClick={onSelect}
                        onDoubleClick={onDoubleClick}
                        path={photo.path}
                        searchQuery={searchQuery}
                        thumbnailPath={photo.thumbnailPath}
                        width={photo.width}
                      />
                    )}
                  </div>
                ))}
              </div>
            );
          }}
          style={{ height: "100%" }}
          totalCount={rows.length}
        />
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
