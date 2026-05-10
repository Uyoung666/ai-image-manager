import { useEffect, useRef, useState } from "react";
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

const COLUMN_CONFIGS = [
  { cols: 2, width: 280, label: "2" },
  { cols: 3, width: 240, label: "3" },
  { cols: 4, width: 200, label: "4" },
  { cols: 5, width: 170, label: "5" },
];

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
  const [configIdx, setConfigIdx] = useState(2); // default 4 columns
  const { cols } = COLUMN_CONFIGS[configIdx];
  const [visibleCount, setVisibleCount] = useState(BATCH_SIZE);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Progressive render: show BATCH_SIZE initially, more on scroll
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
      { rootMargin: "400px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [photos.length]);

  // Initial loading: full skeleton
  if (loading && photos.length === 0) {
    const skeletonCount = cols * 3;
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between border-[rgba(255,255,255,0.06)] border-b px-4 py-2">
          <Skeleton className="h-4 w-24 bg-[#1c1e22]" />
          <div className="flex items-center gap-1">
            {COLUMN_CONFIGS.map((cfg) => (
              <Skeleton
                className="h-5 w-6 rounded-[4px] bg-[#1c1e22]"
                key={cfg.cols}
              />
            ))}
          </div>
        </div>
        <div
          className="flex-1 overflow-y-auto px-2 pt-2"
          style={{ columnCount: cols, columnGap: 8 }}
        >
          {Array.from({ length: skeletonCount }).map((_, i) => (
            <Skeleton
              className="mb-2 w-full rounded-[8px] bg-[#15171a]"
              key={i}
              style={{
                aspectRatio: `${i % 3 === 0 ? 3 / 4 : i % 3 === 1 ? 4 / 3 : 1 / 1}`,
              }}
            />
          ))}
        </div>
      </div>
    );
  }

  const visiblePhotos = photos.slice(0, visibleCount);

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-[rgba(255,255,255,0.06)] border-b px-4 py-2">
        <span className="text-[#a1a1aa] text-[12px]">
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
            {COLUMN_CONFIGS.map((cfg, i) => (
              <button
                className={`rounded-[4px] px-2 py-1 text-[11px] transition-colors ${
                  i === configIdx
                    ? "bg-[#5e6ad2]/20 text-[#5e6ad2]"
                    : "text-[#a1a1aa] hover:bg-white/5 hover:text-[#f7f8f8]"
                }`}
                key={cfg.cols}
                onClick={() => setConfigIdx(i)}
              >
                {cfg.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Masonry waterfall with CSS columns */}
      <div
        className="flex-1 overflow-y-auto px-2 pt-2"
        onContextMenu={onContextMenu}
        style={{ columnCount: cols, columnGap: 8 }}
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
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-[#5e6ad2] border-t-transparent" />
          </div>
        )}
      </div>

      {/* Subtle loading overlay for subsequent loads */}
      {loading && photos.length > 0 && (
        <div className="pointer-events-none absolute top-[41px] right-0 bottom-0 left-0 flex items-start justify-center bg-[#08090a]/30 pt-4">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-[#5e6ad2] border-t-transparent" />
        </div>
      )}
    </div>
  );
}
