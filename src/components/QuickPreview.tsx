// biome-ignore-all lint/a11y/noStaticElementInteractions: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/a11y/noNoninteractiveElementInteractions: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/a11y/useKeyWithClickEvents: scoped component lint cleanup preserves existing UI behavior
import { ArrowLeft, ArrowRight, Expand, X } from "lucide-react";
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import {
  PreviewContextMenu,
  type PreviewMenuState,
} from "@/components/PreviewContextMenu";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipPortalProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useModalFocusTrap } from "@/hooks/use-modal-focus-trap";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { ipc } from "@/ipc/manager";
import { getDateLocale } from "@/utils/date-locale";
import {
  ensureGalleryPhotos,
  getGalleryDataVersion,
  subscribeGalleryData,
} from "@/utils/gallery-data-source";
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
  index?: number;
  onClose: () => void;
  onNavigate: (direction: -1 | 1) => void;
  onOpenLightbox?: () => void;
  photo: QuickPreviewPhoto;
  total?: number;
}

export function QuickPreview({
  photo,
  onClose,
  onNavigate,
  onOpenLightbox,
  index,
  total,
}: QuickPreviewProps) {
  useSyncExternalStore(subscribeGalleryData, getGalleryDataVersion);
  useEffect(() => {
    ensureGalleryPhotos([photo]).catch(() => undefined);
  }, [photo]);
  const { t, i18n } = useTranslation();
  const reduceMotion = useReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
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
  const closedRef = useRef(false);
  const finishClose = useCallback(() => {
    if (!closedRef.current) {
      closedRef.current = true;
      onCloseRef.current();
    }
  }, []);
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  const onOpenLightboxRef = useRef(onOpenLightbox);
  onOpenLightboxRef.current = onOpenLightbox;
  const previewMenuOpenRef = useRef(previewMenu.open);
  previewMenuOpenRef.current = previewMenu.open;

  // ── 入场动画 ──────────────────────────────────────────────────
  useEffect(() => {
    if (reduceMotion) {
      setAnimState("visible");
      return;
    }
    setAnimState("entering");
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() =>
        setAnimState((current) => (current === "exiting" ? current : "visible"))
      );
    });
    return () => cancelAnimationFrame(raf);
  }, [reduceMotion]);

  useEffect(() => {
    if (animState !== "exiting") {
      return;
    }
    // Escape may arrive before the entry transition starts, leaving no transitionend.
    const timer = setTimeout(finishClose, 220);
    return () => clearTimeout(timer);
  }, [animState, finishClose]);

  function handleClose() {
    if (animState === "exiting") {
      return;
    }
    if (reduceMotion) {
      finishClose();
      return;
    }
    setAnimState("exiting");
  }
  const handleCloseRef = useRef(handleClose);
  handleCloseRef.current = handleClose;

  useModalFocusTrap({
    active: true,
    containerRef,
    initialFocus: "container",
    onEscape: () => {
      if (previewMenu.open) {
        setPreviewMenu((menu) => ({ ...menu, open: false }));
      } else {
        handleClose();
      }
    },
  });

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (previewMenuOpenRef.current) {
        return;
      }
      if (e.key === " " || e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        handleCloseRef.current();
      } else if (
        e.key === "Enter" &&
        onOpenLightboxRef.current &&
        !(e.target instanceof Element && e.target.closest("button"))
      ) {
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
      aria-label={t("quickPreviewTitle")}
      aria-modal="true"
      className={`fixed inset-0 z-[200] flex items-center justify-center overflow-hidden bg-black/80 p-2 outline-none ${
        reduceMotion
          ? ""
          : "backdrop-blur-sm transition-all duration-200 ease-out"
      } ${animState === "visible" ? "opacity-100" : "opacity-0"}`}
      data-overlay-kind="quick-preview"
      data-wander-blocking="true"
      onClick={handleClose}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && animState === "exiting") {
          finishClose();
        }
      }}
      ref={containerRef}
      role="dialog"
      tabIndex={-1}
    >
      <TooltipPortalProvider containerRef={containerRef}>
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
          <QuickPreviewImage
            key={`${photo.id}:${photo.path}`}
            onContextMenu={(e) => {
              e.preventDefault();
              setPreviewMenu({
                open: true,
                photoPath: photo.path,
                x: e.clientX,
                y: e.clientY,
              });
            }}
            photo={photo}
          />
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
          <div className="mt-2 flex max-w-full flex-wrap items-center justify-center gap-2">
            <PreviewControl
              disabled={index === 0}
              label={t("previousPhoto")}
              onClick={() => onNavigate(-1)}
            >
              <ArrowLeft className="h-4 w-4" />
            </PreviewControl>
            {index !== undefined && total !== undefined && (
              <span
                aria-live="polite"
                className="text-[12px] text-white/80 tabular-nums"
              >
                {index + 1} / {total}
              </span>
            )}
            <PreviewControl
              disabled={
                index !== undefined && total !== undefined && index >= total - 1
              }
              label={t("nextPhoto")}
              onClick={() => onNavigate(1)}
            >
              <ArrowRight className="h-4 w-4" />
            </PreviewControl>
            {onOpenLightbox && (
              <PreviewControl
                label={t("quickPreviewOpenLightbox")}
                onClick={onOpenLightbox}
              >
                <Expand className="h-4 w-4" />
              </PreviewControl>
            )}
            <PreviewControl label={t("close")} onClick={handleClose}>
              <X className="h-4 w-4" />
            </PreviewControl>
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
      </TooltipPortalProvider>
    </div>
  );
}

function PreviewControl({
  children,
  disabled,
  label,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={label}
          className="flex h-8 w-8 items-center justify-center rounded-md bg-white/10 text-white/90 hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-white disabled:opacity-30"
          disabled={disabled}
          onClick={onClick}
          type="button"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

// A new image identity owns fresh load/error state; late events cannot affect its successor.
function QuickPreviewImage({
  photo,
  onContextMenu,
}: {
  photo: QuickPreviewPhoto;
  onContextMenu: (event: MouseEvent<HTMLImageElement>) => void;
}) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const [loaded, setLoaded] = useState(false);
  const [imgError, setImgError] = useState(false);
  const [srcKey, setSrcKey] = useState(0);
  return (
    <div className="relative flex min-h-0 max-w-full items-center justify-center">
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
              setSrcKey((key) => key + 1);
            }}
            type="button"
          >
            {t("retry")}
          </button>
        </div>
      ) : (
        <img
          alt={photo.filename}
          className={`max-h-[72dvh] min-h-0 max-w-[90dvw] rounded-[8px] object-contain [@media(max-height:560px)]:max-h-[calc(100dvh-9rem)] ${reduceMotion ? "" : "transition-opacity duration-200"} ${loaded ? "opacity-100" : "opacity-0"}`}
          draggable
          height={photo.height ?? 1}
          key={srcKey}
          onContextMenu={onContextMenu}
          onDragStart={(e) => {
            e.preventDefault();
            window.electronAPI?.startDrag?.(photo.path);
          }}
          onError={() => setImgError(true)}
          onLoad={() => setLoaded(true)}
          src={photo.path ? toLocalMediaUrl(photo.path) : undefined}
          width={photo.width ?? 1}
        />
      )}
      {!(loaded || imgError) && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <LoadingSpinner size="xl" variant="overlay" />
        </div>
      )}
    </div>
  );
}
