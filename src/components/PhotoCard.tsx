import { memo, useState } from "react";
import { Skeleton } from "./ui/skeleton";

interface PhotoCardProps {
  id: number;
  path: string;
  filename: string;
  width: number;
  height: number;
  isSelected: boolean;
  onClick: (id: number, event: React.MouseEvent) => void;
  onDoubleClick: (id: number) => void;
}

export const PhotoCard = memo(function PhotoCard({
  id,
  path,
  filename,
  width,
  height,
  isSelected,
  onClick,
  onDoubleClick,
}: PhotoCardProps) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const aspectRatio = width && height ? width / height : 1;

  // Use thumbnail via Electron protocol or direct file path
  const thumbnailSrc = `file://${encodeURI(path).replace(/%2F/g, "/")}`;

  if (error) {
    return (
      <div
        className="relative flex items-center justify-center bg-[#1c1e22] rounded-[8px] overflow-hidden"
        style={{ aspectRatio }}
      >
        <span className="text-[11px] text-[#6b6b75] truncate px-2">{filename}</span>
      </div>
    );
  }

  return (
    <div
      className={`
        relative group cursor-pointer rounded-[8px] overflow-hidden
        transition-all duration-150
        ${isSelected
          ? "ring-2 ring-[#5e6ad2] ring-offset-1 ring-offset-[#08090a]"
          : "hover:ring-1 hover:ring-white/10"
        }
      `}
      style={{ aspectRatio }}
      onClick={(e) => onClick(id, e)}
      onDoubleClick={() => onDoubleClick(id)}
    >
      {!loaded && (
        <Skeleton className="absolute inset-0 rounded-none bg-[#1c1e22]" />
      )}
      <img
        src={thumbnailSrc}
        alt={filename}
        loading="lazy"
        className={`
          w-full h-full object-cover transition-opacity duration-300
          ${loaded ? "opacity-100" : "opacity-0"}
        `}
        onLoad={() => setLoaded(true)}
        onError={() => setError(true)}
      />

      {/* Hover overlay */}
      <div className="absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex items-end px-2 pb-1">
        <span className="text-[#f7f8f8] text-[11px] truncate w-full">{filename}</span>
      </div>

      {/* Selection indicator */}
      {isSelected && (
        <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-[#5e6ad2] flex items-center justify-center">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2.5 6L5 8.5L9.5 3.5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
      )}
    </div>
  );
});
