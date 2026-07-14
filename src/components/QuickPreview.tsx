import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  PreviewContextMenu,
  type PreviewMenuState,
} from "@/components/PreviewContextMenu";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ipc } from "@/ipc/manager";
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
  const [rotation, setRotation] = useState(0);
  const [previewMenu, setPreviewMenu] = useState<PreviewMenuState>({
    open: false,
    photoPath: null,
    x: 0,
    y: 0,
  });
  const [animState, setAnimState] = useState<
    "entering" | "visible" | "exiting"
  >("entering");
  const dragging = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });
  const scaleRef = useRef(1);
  scaleRef.current = scale;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

  // ── 入场动画 ──────────────────────────────────────────────────
  useEffect(() => {
    setAnimState("entering");
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => setAnimState("visible"));
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    setLoaded(false);
    setImgError(false);
    setScale(1);
    setTranslate({ x: 0, y: 0 });
    setRotation(0);
  }, [photo.id]);

  function handleClose() {
    if (animState === "exiting") {
      return;
    }
    setAnimState("exiting");
  }
  const handleCloseRef = useRef(handleClose);
  handleCloseRef.current = handleClose;

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === " " || e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        handleCloseRef.current();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onNavigateRef.current(-1);
      } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onNavigateRef.current(1);
      } else if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.shiftKey) {
          setRotation((prev) => (prev - 90) % 360);
        } else {
          setRotation((prev) => (prev + 90) % 360);
        }
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
    ? new Date(photo.fileDate).toLocaleDateString(
        getDateLocale(i18n.language),
        {
          year: "numeric",
          month: "long",
          day: "numeric",
        }
      )
    : null;

  // 当旋转90度或270度时，宽高需要交换，调整最大尺寸以适应屏幕
  const isRotated90or270 = rotation % 180 !== 0;
  const maxWidth = isRotated90or270 ? "80vh" : "90vw";
  const maxHeight = isRotated90or270 ? "90vw" : "80vh";

  return (
    <div
      className={`fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-sm transition-all duration-200 ease-out ${
        animState === "visible" ? "opacity-100" : "opacity-0"
      }`}
      onClick={handleClose}
      onTransitionEnd={() => {
        if (animState === "exiting") {
          onCloseRef.current();
        }
      }}
      onWheel={handleWheel}
    >
      <div
        className={`relative flex max-h-[90vh] max-w-[90vw] flex-col items-center transition-all duration-200 ease-out ${
          animState === "visible"
            ? "translate-y-0 scale-100 opacity-100"
            : "translate-y-2 scale-95 opacity-0"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {imgError ? (
          <div className="flex flex-col items-center gap-3 rounded-[8px] bg-muted/20 p-12">
            <span className="text-[14px] text-white/60">
              {t("cullImageLoadError")}
            </span>
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
            className={`rounded-[8px] object-contain transition-opacity duration-200 ${loaded ? "opacity-100" : "opacity-0"} ${scale > 1 ? "cursor-grab active:cursor-grabbing" : ""}`}
            draggable
            key={srcKey}
            onContextMenu={(e) => {
              e.preventDefault();
              setPreviewMenu({
                open: true,
                photoPath: photo.path,
                x: e.clientX,
                y: e.clientY,
              });
            }}
            onDoubleClick={handleDoubleClick}
            onDragStart={(e) => {
              e.preventDefault();
              (window as any).electronAPI?.startDrag?.(photo.path);
            }}
            onError={() => setImgError(true)}
            onLoad={() => setLoaded(true)}
            onMouseDown={handleMouseDown}
            src={toLocalMediaUrl(photo.path)}
            style={{
              maxWidth,
              maxHeight,
              transform: `scale(${scale}) translate(${translate.x / scale}px, ${translate.y / scale}px) rotate(${rotation}deg)`,
            }}
          />
        )}
        {!(loaded || imgError) && (
          <div className="absolute inset-0 flex items-center justify-center">
            <LoadingSpinner size="xl" variant="overlay" />
          </div>
        )}
        <div className="mt-3 flex items-center gap-3 text-[12px] text-white/70">
          <span className="font-medium text-white/90">{photo.filename}</span>
          <span>
            {photo.width} × {photo.height}
          </span>
          {dateStr && <span>{dateStr}</span>}
          {scale !== 1 && <span>{Math.round(scale * 100)}%</span>}
          {rotation !== 0 && <span>{rotation}°</span>}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <button
            aria-label={t("rotateLeft")}
            className="rounded-[6px] bg-white/10 px-2 py-1 text-[11px] text-white/70 hover:bg-white/20 hover:text-white"
            onClick={(e) => {
              e.stopPropagation();
              setRotation((prev) => (prev - 90) % 360);
            }}
            type="button"
          >
            ↶
          </button>
          <button
            aria-label={t("rotateRight")}
            className="rounded-[6px] bg-white/10 px-2 py-1 text-[11px] text-white/70 hover:bg-white/20 hover:text-white"
            onClick={(e) => {
              e.stopPropagation();
              setRotation((prev) => (prev + 90) % 360);
            }}
            type="button"
          >
            ↷
          </button>
        </div>
        <div className="mt-2 text-[11px] text-white/40">
          {t("quickPreviewHelp")}
        </div>
      </div>
      <PreviewContextMenu
        menu={previewMenu}
        onClose={() => setPreviewMenu((prev) => ({ ...prev, open: false }))}
        onOpenExplorer={async (path) => {
          await ipc.client.shell.openInExplorer({ path });
        }}
      />
    </div>
  );
}
