import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toLocalMediaUrl } from "@/utils/local-media-url";

export interface ZoomState {
  scale: number;
  translate: { x: number; y: number };
}

interface ZoomableImageProps {
  alt: string;
  filePath: string;
  thumbnailPath?: string | null;
  fillContainer?: boolean;
  syncState?: ZoomState | null;
  onSync?: (state: ZoomState) => void;
  onError?: () => void;
}

export const ZoomableImage = memo(function ZoomableImage({
  alt,
  filePath,
  thumbnailPath,
  fillContainer,
  syncState,
  onSync,
  onError,
}: ZoomableImageProps) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });

  // Refs for drag and sync (avoid stale closures)
  const scaleRef = useRef(1);
  const translateRef = useRef({ x: 0, y: 0 });
  const dragging = useRef(false);
  const didDrag = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });
  const applyingSync = useRef(false);
  const onSyncRef = useRef(onSync);
  onSyncRef.current = onSync;

  // Keep refs in sync with state
  scaleRef.current = scale;
  translateRef.current = translate;

  // Fire sync to parent (always uses latest ref values)
  const fireSync = useCallback(() => {
    if (!applyingSync.current && onSyncRef.current) {
      onSyncRef.current({
        scale: scaleRef.current,
        translate: { ...translateRef.current },
      });
    }
  }, []);

  // Apply sync state from sibling (full state: scale + translate)
  useEffect(() => {
    if (syncState) {
      applyingSync.current = true;
      setScale(syncState.scale);
      setTranslate(syncState.translate);
      applyingSync.current = false;
    }
  }, [syncState]);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.stopPropagation();
      const delta = e.deltaY * 0.005;
      const prev = scaleRef.current;
      const next = Math.max(0.25, Math.min(8, prev - delta));
      setScale(next);
      if (next <= 1) setTranslate({ x: 0, y: 0 });
      // Use setTimeout to fire after state settles
      setTimeout(() => fireSync(), 0);
    },
    [fireSync]
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const next = scaleRef.current <= 1.01 ? 2 : 1;
      setScale(next);
      if (next <= 1) setTranslate({ x: 0, y: 0 });
      setTimeout(() => fireSync(), 0);
    },
    [fireSync]
  );

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (scaleRef.current <= 1) return;
    dragging.current = true;
    didDrag.current = false;
    lastPos.current = { x: e.clientX, y: e.clientY };
  }, []);

  // Prevent click from firing after a drag
  const handleClick = useCallback((e: React.MouseEvent) => {
    if (didDrag.current) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, []);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragging.current) return;
      const dx = e.clientX - lastPos.current.x;
      const dy = e.clientY - lastPos.current.y;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) didDrag.current = true;
      setTranslate((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
      lastPos.current = { x: e.clientX, y: e.clientY };
    }
    function onUp() {
      if (dragging.current) {
        dragging.current = false;
        setTimeout(() => fireSync(), 0);
      }
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [fireSync]);

  const isZoomed = scale > 1;
  const imgTransform = `scale(${scale}) translate(${translate.x / scale}px, ${translate.y / scale}px)`;
  const src = toLocalMediaUrl(thumbnailPath ?? filePath);

  if (hasError) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 text-muted-foreground">
        <span className="text-[11px]">{t("cullImageLoadError")}</span>
      </div>
    );
  }

  return (
    <div
      className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-[6px]"
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onWheel={handleWheel}
    >
      <img
        alt={alt}
        className={`max-h-full max-w-full rounded-[6px] object-contain shadow-lg ${
          loaded ? "opacity-100" : "opacity-0"
        } ${isZoomed ? "cursor-grab active:cursor-grabbing" : ""}`}
        draggable={false}
        onError={() => { setHasError(true); onError?.(); }}
        onLoad={() => setLoaded(true)}
        onMouseDown={handleMouseDown}
        src={src}
        style={{ transform: imgTransform, willChange: isZoomed ? "transform" : "auto" }}
      />
      {!(loaded || hasError) && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
        </div>
      )}
      {isZoomed && (
        <div className="pointer-events-none absolute top-2 right-2 rounded-[4px] bg-black/60 px-1.5 py-0.5 text-[10px] text-white/70">
          {Math.round(scale * 100)}%
        </div>
      )}
    </div>
  );
});
