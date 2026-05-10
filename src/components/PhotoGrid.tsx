import { useState, useMemo, forwardRef } from "react";
import { useTranslation } from "react-i18next";
import { VirtuosoGrid } from "react-virtuoso";
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
  onSelect: (id: number, event: React.MouseEvent) => void;
  onDoubleClick: (id: number) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDeleteSelected?: () => void;
}

const COLUMN_CONFIGS = [
  { cols: 2, label: "2" },
  { cols: 3, label: "3" },
  { cols: 4, label: "4" },
  { cols: 5, label: "5" },
];

export function PhotoGrid({ photos, loading, selectedIds, onSelect, onDoubleClick, onContextMenu, onDeleteSelected }: PhotoGridProps) {
  const { t } = useTranslation();
  const [configIdx, setConfigIdx] = useState(2); // default 4 columns
  const { cols } = COLUMN_CONFIGS[configIdx];

  const ListComponent = useMemo(() =>
    forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
      (props, ref) => (
        <div
          ref={ref}
          {...props}
          className="px-2 pt-2"
          style={{
            ...props.style,
            display: "grid",
            gridTemplateColumns: `repeat(${cols}, 1fr)`,
            gap: 8,
          }}
        />
      )
    )
  , [cols]);

  if (loading) {
    const skeletonCount = cols * 3;
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between px-4 py-2 border-b border-[rgba(255,255,255,0.06)]">
          <Skeleton className="w-24 h-4 bg-[#1c1e22]" />
          <div className="flex items-center gap-1">
            {COLUMN_CONFIGS.map((cfg, i) => (
              <Skeleton key={cfg.cols} className="w-6 h-5 bg-[#1c1e22] rounded-[4px]" />
            ))}
          </div>
        </div>
        <div
          className="flex-1 overflow-hidden px-2 pt-2"
          style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 8 }}
        >
          {Array.from({ length: skeletonCount }).map((_, i) => (
            <Skeleton
              key={i}
              className="w-full bg-[#15171a] rounded-[8px]"
              style={{ aspectRatio: `${i % 3 === 0 ? 3/4 : i % 3 === 1 ? 4/3 : 1/1}` }}
            />
          ))}
        </div>
      </div>
    );
  }

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

      <div onContextMenu={onContextMenu} style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <VirtuosoGrid
          style={{ flex: 1 }}
          totalCount={photos.length}
          components={{ List: ListComponent }}
          itemContent={(index) => {
            const photo = photos[index];
            return (
              <div data-photo-id={photo.id} data-photo-path={photo.path}>
                <PhotoCard
                  key={photo.id}
                  id={photo.id}
                  path={photo.path}
                  thumbnailPath={photo.thumbnailPath}
                  filename={photo.filename}
                  width={photo.width}
                  height={photo.height}
                  isSelected={selectedIds.has(photo.id)}
                  onClick={onSelect}
                  onDoubleClick={onDoubleClick}
                />
              </div>
            );
          }}
        />
      </div>
    </div>
  );
}
