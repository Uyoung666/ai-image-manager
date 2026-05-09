import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PhotoCard } from "./PhotoCard";

interface Photo {
  id: number; path: string; filename: string;
  width: number; height: number; fileSize: number;
  thumbnailPath: string; isIndexed: boolean;
}
interface PhotoGridProps {
  photos: Photo[];
  loading: boolean;
  selectedIds: Set<number>;
  onSelect: (id: number, event: React.MouseEvent) => void;
  onDoubleClick: (id: number) => void;
}

const COLUMN_SIZES = [160, 200, 240, 280];

export function PhotoGrid({ photos, loading, selectedIds, onSelect, onDoubleClick }: PhotoGridProps) {
  const { t } = useTranslation();
  const [columnSizeIdx, setColumnSizeIdx] = useState(2);
  const itemSize = COLUMN_SIZES[columnSizeIdx];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-[#5e6ad2] border-t-transparent rounded-full animate-spin" />
          <span className="text-[#a1a1aa] text-[13px]">{t("loadingPhotos")}</span>
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
          {COLUMN_SIZES.map((size, i) => (
            <button
              key={size}
              onClick={() => setColumnSizeIdx(i)}
              className={`px-2 py-1 text-[11px] rounded-[4px] transition-colors ${
                i === columnSizeIdx
                  ? "bg-[#5e6ad2]/20 text-[#5e6ad2]"
                  : "text-[#a1a1aa] hover:text-[#f7f8f8] hover:bg-white/5"
              }`}
            >
              {size}px
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      <div
        className="flex-1 overflow-y-auto p-2"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(auto-fill, minmax(${itemSize}px, 1fr))`,
          gap: 4,
          alignContent: "start",
        }}
      >
        {photos.map((photo) => (
          <PhotoCard
            key={photo.id}
            id={photo.id}
            path={photo.path}
            filename={photo.filename}
            width={photo.width}
            height={photo.height}
            isSelected={selectedIds.has(photo.id)}
            onClick={onSelect}
            onDoubleClick={onDoubleClick}
          />
        ))}
      </div>
    </div>
  );
}
