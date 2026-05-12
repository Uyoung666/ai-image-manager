import {
  type ComponentProps,
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  similarity?: number;
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

// CSS-columns masonry List — items flow top-to-bottom within each column,
// which yields a gapless Pinterest-style waterfall layout.
const MasonryList = forwardRef<
  HTMLDivElement,
  ComponentProps<"div"> & { columnCount: number }
>(({ columnCount, style, children, ...rest }, ref) => (
  <div
    {...rest}
    ref={ref}
    style={{
      ...style,
      columnCount,
      columnGap: GAP,
    }}
  >
    {children}
  </div>
));
MasonryList.displayName = "MasonryList";

function renderMasonryList(columnCount: number) {
  return function List(props: ComponentProps<"div">) {
    return <MasonryList {...props} columnCount={columnCount} />;
  };
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
  const [densityIdx, setDensityIdx] = useState(1);
  const [columnCount, setColumnCount] = useState(4);
  const [compact, setCompact] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const targetColWidth = DENSITY_CONFIGS[densityIdx].targetColWidth;

  // Responsive column count
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

  // Estimated item height — used by Virtuoso for scrollbar / initial measurements.
  // CSS columns compact items, so the effective list height ≈ (itemCount * estimatedHeight) / columnCount.
  // Virtuoso uses defaultItemHeight × itemCount as the total estimate, so we pass
  // a down-scaled value so the scrollbar closely matches the real column-based height.
  const defaultItemHeight = useMemo(() => {
    if (!containerRef.current) {
      return 200;
    }
    const cw = containerRef.current.clientWidth;
    const colW = (cw - 16 - (columnCount - 1) * GAP) / columnCount;
    // Assume average aspect ratio ~1.33 (4:3 landscape-ish).
    // Item height = gap + container (colW / 1.33) + gap.
    const base = colW / 1.33 + GAP;
    // Scale down because CSS columns compact N items into one column height.
    return Math.max(80, Math.round(base / columnCount));
  }, [columnCount]);

  // Skeleton aspect ratios
  const skeletonAspects = useCallback(
    () => [3 / 4, 4 / 3, 1 / 1, 3 / 2, 2 / 3],
    []
  );

  // Skeleton screen — keep column-based skeleton
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

  // Empty state
  if (!loading && photos.length === 0) {
    return (
      <div className="flex flex-1 flex-col">
        <div className="flex items-center justify-between border-border border-b px-4 py-2">
          <span className="truncate text-[12px] text-muted-foreground">
            {t("photosCount", { count: 0 })}
          </span>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <span className="text-[#6b6b75] text-[13px]">{t("noPhotos")}</span>
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
              className="rounded-[4px] px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-foreground/5"
              onClick={onRenameSelected}
            >
              {compact ? "重命名" : `重命名 (${selectedIds.size})`}
            </button>
          )}
          {selectedIds.size > 0 && onConvertSelected && (
            <button
              className="rounded-[4px] px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-foreground/5"
              onClick={onConvertSelected}
            >
              {compact ? "转换" : `格式转换 (${selectedIds.size})`}
            </button>
          )}
          {selectedIds.size > 0 && onExportSelected && (
            <button
              className="rounded-[4px] px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-foreground/5"
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

      {/* Masonry grid with virtual scrolling */}
      <div className="flex-1" onContextMenu={onContextMenu} ref={containerRef}>
        <Virtuoso
          className="scrollbar-thin px-2"
          components={{
            List: renderMasonryList(columnCount),
          }}
          computeItemKey={(_index, photo) => photo.id}
          data={photos}
          defaultItemHeight={defaultItemHeight}
          increaseViewportBy={{ top: 400, bottom: 400 }}
          itemContent={(_index, photo) => (
            <div className="pb-2" style={{ breakInside: "avoid" }}>
              <PhotoCard
                filename={photo.filename}
                height={photo.height}
                id={photo.id}
                isSelected={selectedIds.has(photo.id)}
                onClick={onSelect}
                onDoubleClick={onDoubleClick}
                path={photo.path}
                searchQuery={searchQuery}
                similarity={photo.similarity}
                thumbnailPath={photo.thumbnailPath}
                width={photo.width}
              />
            </div>
          )}
          style={{ height: "100%" }}
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
