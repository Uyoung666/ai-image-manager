// biome-ignore-all lint/a11y/noStaticElementInteractions: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/a11y/noNoninteractiveElementInteractions: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/a11y/useKeyWithClickEvents: scoped component lint cleanup preserves existing UI behavior
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  PreviewContextMenu,
  type PreviewMenuState,
} from "@/components/PreviewContextMenu";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
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
  onOpenLightbox?: () => void;
  photo: QuickPreviewPhoto;
}

export function QuickPreview({
  photo,
  onClose,
  onNavigate,
  onOpenLightbox,
}: QuickPreviewProps) {
  const { t, i18n } = useTranslation();
  const reduceMotion = useReducedMotion();
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
  const onOpenLightboxRef = useRef(onOpenLightbox);
  onOpenLightboxRef.current = onOpenLightbox;

  // ── 入场动画 ──────────────────────────────────────────────────
  useEffect(() => {
    if (reduceMotion) {
      setAnimState("visible");
      return;
    }
    setAnimState("entering");
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => setAnimState("visible"));
    });
    return () => cancelAnimationFrame(raf);
  }, [reduceMotion]);

  useEffect(() => {
    setLoaded(false);
    setImgError(false);
  }, []);

  function handleClose() {
    if (animState === "exiting") {
      return;
    }
    if (reduceMotion) {
      onCloseRef.current();
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
      } else if (e.key === "Enter" && onOpenLightboxRef.current) {
        e.preventDefault();
        e.stopImmediatePropagation();
        onOpenLightboxRef.current();
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
      className={`fixed inset-0 z-[200] flex items-center justify-center overflow-hidden bg-black/80 p-2 ${
        reduceMotion
          ? ""
          : "backdrop-blur-sm transition-all duration-200 ease-out"
      } ${animState === "visible" ? "opacity-100" : "opacity-0"}`}
      data-wander-blocking="true"
      onClick={handleClose}
      onTransitionEnd={() => {
        if (animState === "exiting") {
          onCloseRef.current();
        }
      }}
    >
      <div
        className={`relative flex max-h-[calc(100dvh-1rem)] min-h-0 max-w-[calc(100vw-1rem)] flex-col items-center ${
          reduceMotion ? "" : "transition-all duration-200 ease-out"
        } ${
          animState === "visible"
            ? "translate-y-0 scale-100 opacity-100"
            : "translate-y-2 scale-95 opacity-0"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {imgError ? (
          <div className="flex max-w-full flex-col items-center gap-3 rounded-[8px] bg-muted/20 p-6 sm:p-12">
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
              type="button"
            >
              {t("retry")}
            </button>
          </div>
        ) : (
          <img
            alt={photo.filename}
            className={`max-h-[80vh] min-h-0 max-w-[90vw] rounded-[8px] object-contain [@media(max-height:560px)]:max-h-[calc(100dvh-5.5rem)] ${
              reduceMotion ? "" : "transition-opacity duration-200"
            } ${loaded ? "opacity-100" : "opacity-0"}`}
            draggable
            height={photo.height ?? 1}
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
              window.electronAPI?.startDrag?.(photo.path);
            }}
            onError={() => setImgError(true)}
            onLoad={() => setLoaded(true)}
            src={toLocalMediaUrl(photo.path)}
            width={photo.width ?? 1}
          />
        )}
        {!(loaded || imgError) && (
          <div className="absolute inset-0 flex items-center justify-center">
            <LoadingSpinner size="xl" variant="overlay" />
          </div>
        )}
        <div className="mt-3 flex max-w-full flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[12px] text-white/70">
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="max-w-[min(24rem,70vw)] truncate font-medium text-white/90"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: truncated filename must expose its Tooltip to keyboard users
                tabIndex={0}
              >
                {photo.filename}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-[min(28rem,calc(100vw-1rem))] break-all">
              {photo.filename}
            </TooltipContent>
          </Tooltip>
          <span className="shrink-0">
            {photo.width} × {photo.height}
          </span>
          {dateStr && <span className="shrink-0">{dateStr}</span>}
        </div>
        <div className="mt-2 max-w-full text-center text-[11px] text-white/40">
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
