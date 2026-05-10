import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { PhotoCard } from "./PhotoCard";
import { Skeleton } from "./ui/skeleton";

interface Photo {
  id: number; path: string; filename: string;
  width: number; height: number; fileSize: number;
  thumbnailPath: string | null; isIndexed: boolean;
}
interface PhotoGridProps {
  photos: Photo[];
  loading: boolean;
  selectedIds: Set<number>;
  searchQuery?: string;
  onSelect: (id: number, event: React.MouseEvent) => void;
  onDoubleClick: (id: number) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDeleteSelected?: () => void;
}

const COLUMN_CONFIGS = [
  { cols: 2, width: 280, label: "2" },
  { cols: 3, width: 240, label: "3" },
  { cols: 4, width: 200, label: "4" },
  { cols: 5, width: 170, label: "5" },
];

const BATCH_SIZE = 80;

export function PhotoGrid({ photos, loading, selectedIds, searchQuery, onSelect, onDoubleClick, onContextMenu, onDeleteSelected }: PhotoGridProps) {
  const { t } = useTranslation();
  const [configIdx, setConfigIdx] = useState(2); // default 4 columns
  const { cols } = COLUMN_CONFIGS[configIdx];
  const [visibleCount, setVisibleCount] = useState(BATCH_SIZE);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Progressive render: show BATCH_SIZE initially, more on scroll
  useEffect(() => {
    setVisibleCount(BATCH_SIZE);
  }, [photos, cols]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisibleCount(prev => Math.min(prev + BATCH_SIZE, photos.length));
        }
      },
      { rootMargin: "400px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [photos.length, visibleCount]);

  // Initial loading: full skeleton
  if (loading && photos.length === 0) {
    const skeletonCount = cols * 3;
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between px-4 py-2 border-b border-[rgba(255,255,255,0.06)]">
          <Skeleton className="w-24 h-4 bg-[#1c1e22]" />
          <div className="flex items-center gap-1">
            {COLUMN_CONFIGS.map((cfg) => (
              <Skeleton key={cfg.cols} className="w-6 h-5 bg-[#1c1e22] rounded-[4px]" />
            ))}
          </div>
        </div>
        <div
          className="flex-1 overflow-y-auto px-2 pt-2"
          style={{ columnCount: cols, columnGap: 8 }}
        >
          {Array.from({ length: skeletonCount }).map((_, i) => (
            <Skeleton
              key={i}
              className="w-full bg-[#15171a] rounded-[8px] mb-2"
              style={{ aspectRatio: `${i % 3 === 0 ? 3/4 : i % 3 === 1 ? 4/3 : 1/1}` }}
            />
          ))}
        </div>
      </div>
    );
  }

  const visiblePhotos = photos.slice(0, visibleCount);

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[rgba(255,255,255,0.06)]">
        <span className="text-[#a1a1aa] text-[12px]">
          {t("photosCount", { count: photos.length.toLocaleString() })}
          {selectedIds.size > 0 && t("photosSelected", { count: selectedIds.size })}
        </span>
        <div className="flex items-center gap-2">
          {selectedIds.size > 0 && onDeleteSelected && (
            <button
              onClick={onDeleteSelected}
              className="px-2 py-1 text-[11px] text-[#e5484d] hover:bg-[#e5484d]/10 rounded-[4px] transition-colors"
            >
              删除选中 ({selectedIds.size})
            </button>
          )}
          <div className="flex items-center gap-1">
            {COLUMN_CONFIGS.map((cfg, i) => (
              <button
                key={cfg.cols}
                onClick={() => setConfigIdx(i)}
                className={`px-2 py-1 text-[11px] rounded-[4px] transition-colors ${
                  i === configIdx
                    ? "bg-[#5e6ad2]/20 text-[#5e6ad2]"
                    : "text-[#a1a1aa] hover:text-[#f7f8f8] hover:bg-white/5"
                }`}
              >
                {cfg.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Masonry waterfall with CSS columns */}
      <div
        onContextMenu={onContextMenu}
        className="flex-1 overflow-y-auto px-2 pt-2"
        style={{ columnCount: cols, columnGap: 8 }}
      >
        {visiblePhotos.map((photo) => (
          <PhotoCard
            key={photo.id}
            id={photo.id}
            path={photo.path}
            thumbnailPath={photo.thumbnailPath}
            filename={photo.filename}
            width={photo.width}
            height={photo.height}
            isSelected={selectedIds.has(photo.id)}
            searchQuery={searchQuery}
            onClick={onSelect}
            onDoubleClick={onDoubleClick}
          />
        ))}

        {/* Sentinel for progressive loading */}
        {visibleCount < photos.length && (
          <div ref={sentinelRef} className="flex items-center justify-center py-4 h-12">
            <div className="w-5 h-5 border-2 border-[#5e6ad2] border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>

      {/* Subtle loading overlay for subsequent loads */}
      {loading && photos.length > 0 && (
        <div className="absolute top-[41px] left-0 right-0 bottom-0 bg-[#08090a]/30 pointer-events-none flex items-start justify-center pt-4">
          <div className="w-6 h-6 border-2 border-[#5e6ad2] border-t-transparent rounded-full animate-spin" />
        </div>
      )}
    </div>
  );
}
