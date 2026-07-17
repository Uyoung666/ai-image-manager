import { useEffect, useRef, useState } from "react";
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
  const [previewMenu, setPreviewMenu] = useState<PreviewMenuState>({
    open: false,
    photoPath: null,
    x: 0,
    y: 0,
  });
  const [animState, setAnimState] = useState<
    "entering" | "visible" | "exiting"
  >("entering");
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
      }
    }
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
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
            className={`max-h-[80vh] max-w-[90vw] rounded-[8px] object-contain transition-opacity duration-200 ${loaded ? "opacity-100" : "opacity-0"}`}
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
            onDragStart={(e) => {
              e.preventDefault();
              (window as any).electronAPI?.startDrag?.(photo.path);
            }}
            onError={() => setImgError(true)}
            onLoad={() => setLoaded(true)}
            src={toLocalMediaUrl(photo.path)}
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
