import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getDateLocale } from "@/utils/date-locale";
import { toLocalMediaUrl } from "@/utils/local-media-url";

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

export function QuickPreview({
  photo,
  onClose,
  onNavigate,
}: QuickPreviewProps) {
  const { t, i18n } = useTranslation();
  const [loaded, setLoaded] = useState(false);
  const [imgError, setImgError] = useState(false);
  const [srcKey, setSrcKey] = useState(0);
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const dragging = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });
  const scaleRef = useRef(1);
  scaleRef.current = scale;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

  useEffect(() => {
    setLoaded(false);
    setImgError(false);
    setScale(1);
    setTranslate({ x: 0, y: 0 });
  }, [photo.id]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === " " || e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onCloseRef.current();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onNavigateRef.current(-1);
      } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onNavigateRef.current(1);
      }
    }
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.stopPropagation();
    setScale((prev) => Math.max(0.5, Math.min(5, prev - e.deltaY * 0.002)));
  }, []);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setScale((prev) => {
      if (prev === 1) {
        return 2;
      }
      setTranslate({ x: 0, y: 0 });
      return 1;
    });
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (scaleRef.current <= 1) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    dragging.current = true;
    lastPos.current = { x: e.clientX, y: e.clientY };
  }, []);

  useEffect(() => {
    function handleMouseMove(e: MouseEvent) {
      if (!dragging.current) {
        return;
      }
      setTranslate((prev) => ({
        x: prev.x + e.clientX - lastPos.current.x,
        y: prev.y + e.clientY - lastPos.current.y,
      }));
      lastPos.current = { x: e.clientX, y: e.clientY };
    }
    function handleMouseUp() {
      dragging.current = false;
    }
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  const dateStr = photo.fileDate
    ? new Date(photo.fileDate).toLocaleDateString(getDateLocale(i18n.language), {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
      onWheel={handleWheel}
    >
      <div
        className="relative flex max-h-[90vh] max-w-[90vw] flex-col items-center"
        onClick={(e) => e.stopPropagation()}
      >
        {imgError ? (
          <div className="flex flex-col items-center gap-3 rounded-[8px] bg-muted/20 p-12">
            <span className="text-[14px] text-white/60">{t("cullImageLoadError")}</span>
            <button
              className="rounded-[6px] bg-white/10 px-3 py-1.5 text-[12px] text-white/80 hover:bg-white/20"
              onClick={() => {
                setImgError(false);
                setLoaded(false);
                setSrcKey((k) => k + 1);
              }}
            >
              {t("retry")}
            </button>
          </div>
        ) : (
          <img
            alt={photo.filename}
            className={`max-h-[80vh] max-w-[90vw] rounded-[8px] object-contain transition-opacity duration-200 ${loaded ? "opacity-100" : "opacity-0"} ${scale > 1 ? "cursor-grab active:cursor-grabbing" : ""}`}
            draggable={false}
            key={srcKey}
            onDoubleClick={handleDoubleClick}
            onError={() => setImgError(true)}
            onLoad={() => setLoaded(true)}
            onMouseDown={handleMouseDown}
            src={toLocalMediaUrl(photo.path)}
            style={{
              transform: `scale(${scale}) translate(${translate.x / scale}px, ${translate.y / scale}px)`,
            }}
          />
        )}
        {!loaded && !imgError && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          </div>
        )}
        <div className="mt-3 flex items-center gap-3 text-[12px] text-white/70">
          <span className="font-[510] text-white/90">{photo.filename}</span>
          <span>
            {photo.width} × {photo.height}
          </span>
          {dateStr && <span>{dateStr}</span>}
          {scale !== 1 && <span>{Math.round(scale * 100)}%</span>}
        </div>
        <div className="mt-2 text-[11px] text-white/40">
          {t("quickPreviewHelp")}
        </div>
      </div>
    </div>
  );
}
