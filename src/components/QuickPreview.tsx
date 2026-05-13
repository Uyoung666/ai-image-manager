import { useCallback, useEffect, useState } from "react";

interface QuickPreviewPhoto {
  fileDate?: number | null;
  filename: string;
  height: number;
  id: number;
  path: string;
  width: number;
}

interface QuickPreviewProps {
  onClose: () => void;
  onNavigate: (direction: -1 | 1) => void;
  photo: QuickPreviewPhoto;
}

function toLocalMediaUrl(filePath: string): string {
  const encoded = filePath
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `local-media://${encoded}`;
}

export function QuickPreview({ photo, onClose, onNavigate }: QuickPreviewProps) {
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setLoaded(false);
  }, [photo.id]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === " " || e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        onNavigate(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        onNavigate(1);
      }
    },
    [onClose, onNavigate],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const dateStr = photo.fileDate
    ? new Date(photo.fileDate).toLocaleDateString("zh-CN", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative flex max-h-[90vh] max-w-[90vw] flex-col items-center"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          alt={photo.filename}
          className={`max-h-[80vh] max-w-[90vw] rounded-[8px] object-contain transition-opacity duration-200 ${loaded ? "opacity-100" : "opacity-0"}`}
          onLoad={() => setLoaded(true)}
          src={toLocalMediaUrl(photo.path)}
        />
        {!loaded && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          </div>
        )}
        <div className="mt-3 flex items-center gap-3 text-[12px] text-white/70">
          <span className="font-[510] text-white/90">{photo.filename}</span>
          <span>{photo.width} × {photo.height}</span>
          {dateStr && <span>{dateStr}</span>}
        </div>
        <div className="mt-2 text-[11px] text-white/40">
          Space / Esc 关闭 · ← → 切换
        </div>
      </div>
    </div>
  );
}
