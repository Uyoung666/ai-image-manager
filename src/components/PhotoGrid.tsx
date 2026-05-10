import { useCallback, useEffect, useRef, useState } from "react";
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
  onDeleteSelected?: () => void;
  onDoubleClick: (id: number) => void;
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
const BATCH_SIZE = 80;

export function PhotoGrid({
  photos,
  loading,
  selectedIds,
  searchQuery,
  onSelect,
  onDoubleClick,
  onContextMenu,
  onDeleteSelected,
}: PhotoGridProps) {
  const { t } = useTranslation();
  const [densityIdx, setDensityIdx] = useState(1); // default "中" / 220px
  const [columnCount, setColumnCount] = useState(4);
  const [visibleCount, setVisibleCount] = useState(BATCH_SIZE);
  const containerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const targetColWidth = DENSITY_CONFIGS[densityIdx].targetColWidth;

  // Responsive columns via ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      const cols = Math.max(MIN_COLUMNS, Math.floor(width / targetColWidth));
      setColumnCount(cols);
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
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisibleCount((prev) => Math.min(prev + BATCH_SIZE, photos.length));
        }
      },
      { rootMargin: "400px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [photos.length]);

  // Skeleton: mimic a range of aspect ratios
  const skeletonAspects = useCallback(
    () => [3 / 4, 4 / 3, 1 / 1, 3 / 2, 2 / 3],
    []
  );

  if (loading && photos.length === 0) {
    const skels = Array.from({ length: columnCount * 3 }, (_, i) => i);
    return (
      <div className="flex flex-1 flex-col">
        <div className="flex items-center justify-between border-border border-b px-4 py-2">
          <Skeleton className="h-4 w-24 bg-card" />
          <div className="flex items-center gap-1">
            {DENSITY_CONFIGS.map((cfg) => (
              <Skeleton className="h-5 w-6 rounded-[4px] bg-card" key={cfg.label} />
            ))}
          </div>
        </div>
        <div
          className="flex-1 overflow-y-auto px-2 pt-2"
          style={{ columnCount, columnGap: 8 }}
        >
          {skels.map((i) => (
            <Skeleton
              className="mb-2 w-full rounded-[8px] bg-muted"
              key={i}
              style={{
                aspectRatio: skeletonAspects()[i % skeletonAspects().length],
              }}
            />
          ))}
        </div>
      </div>
    );
  }

  const visiblePhotos = photos.slice(0, visibleCount);

  return (
    <div className="flex flex-1 flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-border border-b px-4 py-2">
        <span className="text-muted-foreground text-[12px]">
          {t("photosCount", { count: photos.length.toLocaleString() })}
          {selectedIds.size > 0 &&
            t("photosSelected", { count: selectedIds.size })}
        </span>
        <div className="flex items-center gap-2">
          {selectedIds.size > 0 && onDeleteSelected && (
            <button
              className="rounded-[4px] px-2 py-1 text-[#e5484d] text-[11px] transition-colors hover:bg-[#e5484d]/10"
              onClick={onDeleteSelected}
            >
              删除选中 ({selectedIds.size})
            </button>
          )}
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
        </div>
      </div>

      {/* Masonry grid via CSS columns */}
      <div
        className="flex-1 overflow-y-auto px-2 pt-2"
        onContextMenu={onContextMenu}
        ref={containerRef}
        style={{ columnCount, columnGap: 8 }}
      >
        {visiblePhotos.map((photo) => (
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
