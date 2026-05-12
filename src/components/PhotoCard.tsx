import { memo, useState } from "react";

interface PhotoCardProps {
  filename: string;
  height: number;
  id: number;
  isSelected: boolean;
  onClick: (id: number, event: React.MouseEvent) => void;
  onDoubleClick: (id: number) => void;
  path: string;
  searchQuery?: string;
  thumbnailPath: string | null;
  width: number;
}

function HighlightText({ text, query }: { text: string; query?: string }) {
  if (!query) {
    return <>{text}</>;
  }
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) {
    return <>{text}</>;
  }
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded-[4px] bg-primary/40 text-foreground">
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  );
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
  searchQuery,
  onClick,
  onDoubleClick,
}: PhotoCardProps) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  const src = thumbnailPath
    ? toLocalMediaUrl(thumbnailPath)
    : toLocalMediaUrl(path);

  // Clamp extreme aspect ratios for visual consistency (P1-1)
  const rawAspect = width && height ? width / height : 4 / 3;
  const aspectRatio = Math.max(0.6, Math.min(rawAspect, 3.0));

  if (error) {
    return (
      <div
        className="relative flex w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-[8px] bg-muted"
        style={{ aspectRatio }}
      >
        <svg
          fill="none"
          height="32"
          stroke="#6b6b75"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          viewBox="0 0 24 24"
          width="32"
        >
          <rect height="18" rx="2" ry="2" width="18" x="3" y="3" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
        <span className="max-w-full truncate px-2 text-[#6b6b75] text-[10px]">
          {filename}
        </span>
      </div>
    );
  }

  return (
    <div
      className={`group relative w-full cursor-pointer overflow-hidden rounded-[8px] bg-muted transition-all duration-150 ${
        isSelected
          ? "ring-2 ring-primary ring-offset-1 ring-offset-background"
          : "hover:brightness-110 hover:ring-1 hover:ring-white/10"
      }
      `}
      onClick={(e) => onClick(id, e)}
      onContextMenu={undefined}
      onDoubleClick={() => onDoubleClick(id)}
      style={{ aspectRatio }}
      data-photo-id={id}
      data-photo-path={path}
    >
      {!loaded && <div className="absolute inset-0 bg-muted" />}
      <img
        alt={filename}
        className={`h-full w-full object-cover transition-all duration-700 group-hover:scale-105 ${
          loaded ? "scale-100 opacity-100" : "scale-105 opacity-0"
        }`}
        loading="lazy"
        onError={() => setError(true)}
        onLoad={() => setLoaded(true)}
        src={src}
      />

      {/* Hover overlay */}
      <div className="absolute inset-0 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
        <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/70 via-black/30 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 px-2.5 pb-2">
          <p className="truncate font-[510] text-[#f7f8f8] text-[11px] leading-tight">
            <HighlightText query={searchQuery} text={filename} />
          </p>
          {width > 0 && height > 0 && (
            <p className="mt-0.5 text-[#a1a1aa] text-[10px]">
              {width} × {height}
            </p>
          )}
        </div>
      </div>

      {/* Selection indicator */}
      {isSelected && (
        <div className="absolute top-2 right-2 flex h-5 w-5 items-center justify-center rounded-full bg-primary ring-1 ring-white/20">
          <svg fill="none" height="12" viewBox="0 0 12 12" width="12">
            <path
              d="M2.5 6L5 8.5L9.5 3.5"
              stroke="white"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
            />
          </svg>
        </div>
      )}
    </div>
  );
});
