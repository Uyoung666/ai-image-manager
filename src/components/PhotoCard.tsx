import { memo, useState } from "react";
import { useTranslation } from "react-i18next";

interface PhotoCardProps {
  id: number;
  path: string;
  thumbnailPath: string | null;
  filename: string;
  width: number;
  height: number;
  isSelected: boolean;
  onClick: (id: number, event: React.MouseEvent) => void;
  onDoubleClick: (id: number) => void;
}

function toLocalMediaUrl(filePath: string): string {
  const encoded = filePath
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `local-media://${encoded}`;
}

export const PhotoCard = memo(function PhotoCard({
  id,
  path,
  thumbnailPath,
  filename,
  width,
  height,
  isSelected,
  onClick,
  onDoubleClick,
}: PhotoCardProps) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  const src = thumbnailPath
    ? toLocalMediaUrl(thumbnailPath)
    : toLocalMediaUrl(path);

  const aspectRatio = width && height ? width / height : 4 / 3;

  if (error) {
    return (
      <div
        className="relative flex flex-col items-center justify-center bg-[#15171a] rounded-[8px] overflow-hiddengap-2"
        style={{ aspectRatio }}
      >
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#6b6b75" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
        <span className="text-[10px] text-[#6b6b75] truncate px-2 max-w-full">{filename}</span>
      </div>
    );
  }

  return (
    <div
      className={`
        relative group cursor-pointer rounded-[8px] overflow-hidden
        transition-all duration-150 bg-[#15171a]
        ${isSelected
          ? "ring-2 ring-[#5e6ad2] ring-offset-1 ring-offset-[#08090a] shadow-[0_0_20px_rgba(94,106,210,0.15)]"
          : "hover:ring-1 hover:ring-white/10 hover:shadow-[0_4px_20px_rgba(0,0,0,0.4)]"
        }
      `}
      style={{ aspectRatio }}
      onClick={(e) => onClick(id, e)}
      onDoubleClick={() => onDoubleClick(id)}
    >
      {!loaded && (
        <div className="absolute inset-0 bg-gradient-to-b from-[#1c1e22] to-[#15171a] animate-pulse" />
      )}
      <img
        src={src}
        alt={filename}
        loading="lazy"
        className={`
          w-full h-full object-cover transition-all duration-500
          ${loaded ? "opacity-100 scale-100" : "opacity-0 scale-105"}
        `}
        onLoad={() => setLoaded(true)}
        onError={() => setError(true)}
      />

      {/* Hover overlay */}
      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
        <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/70 via-black/30 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 px-2.5 pb-2">
          <p className="text-[#f7f8f8] text-[11px] font-[510] truncate leading-tight">{filename}</p>
          {width > 0 && height > 0 && (
            <p className="text-[#a1a1aa] text-[10px] mt-0.5">{width} × {height}</p>
          )}
        </div>
      </div>

      {/* Selection indicator */}
      {isSelected && (
        <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-[#5e6ad2] flex items-center justify-center shadow-lg">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2.5 6L5 8.5L9.5 3.5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
      )}
    </div>
  );
});
