import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import Lightbox, { type ZoomRef } from "yet-another-react-lightbox";
import {
  Captions,
  Counter,
  Fullscreen,
  Thumbnails,
  Zoom,
} from "yet-another-react-lightbox/plugins";
import "yet-another-react-lightbox/styles.css";
import "yet-another-react-lightbox/plugins/captions.css";
import "yet-another-react-lightbox/plugins/counter.css";
import "yet-another-react-lightbox/plugins/thumbnails.css";
import { PhotoDetailPanel } from "@/components/PhotoDetailPanel";
import {
  PreviewContextMenu,
  type PreviewMenuState,
} from "@/components/PreviewContextMenu";
import { ipc } from "@/ipc/manager";
import { preloadImage, toLocalMediaUrl } from "@/utils/local-media-url";

interface Photo {
  filename: string;
  fileSize: number;
  format?: string;
  height: number;
  id: number;
  path: string;
  thumbnailPath?: string | null;
  width: number;
}

interface PhotoLightboxProps {
  index: number;
  onClose: (currentIndex: number) => void;
  open: boolean;
  photos: Photo[];
}

const SLIDESHOW_DELAYS = [
  { label: "3s", value: 3000 },
  { label: "5s", value: 5000 },
  { label: "10s", value: 10_000 },
];

function formatDimensions(w: number, h: number): string {
  if (!(w && h)) {
    return "";
  }
  const mp = ((w * h) / 1_000_000).toFixed(1);
  return `${w} × ${h} · ${mp}MP`;
}

export const PhotoLightbox = memo(function PhotoLightbox({
  photos,
  index,
  open,
  onClose,
}: PhotoLightboxProps) {
  const { t } = useTranslation();
  const [photoIndex, setPhotoIndex] = useState(index);
  const [playing, setPlaying] = useState(false);
  const [delay, setDelay] = useState(5000);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const programmaticRef = useRef(false);
  const photoIndexRef = useRef(photoIndex);
  photoIndexRef.current = photoIndex;
  const photosRef = useRef(photos);
  photosRef.current = photos;
  const [overlayVisible, setOverlayVisible] = useState(true);
  const [infoPanelVisible, setInfoPanelVisible] = useState(false);
  const [rotation, setRotation] = useState(0);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [panelAnchor, setPanelAnchor] = useState<HTMLDivElement | null>(null);
  const zoomRef = useRef<ZoomRef>(null);
  const [previewMenu, setPreviewMenu] = useState<PreviewMenuState>({
    open: false,
    photoPath: null,
    x: 0,
    y: 0,
  });

  // 灯箱关闭时确保右键菜单也关闭
  useEffect(() => {
    if (!open) {
      setPreviewMenu((prev) => (prev.open ? { ...prev, open: false } : prev));
    }
  }, [open]);

  // 右键菜单 — 原生 capture 阶段绕过 Lightbox 库的 React 事件拦截
  useEffect(() => {
    if (!open) {
      return;
    }

    function handleContextMenu(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest(".yarl__fullscreen")) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const idx = photoIndexRef.current;
      const p = photosRef.current[idx];
      if (p) {
        setPreviewMenu({
          open: true,
          photoPath: p.path,
          x: e.clientX,
          y: e.clientY,
        });
      }
    }

    document.addEventListener("contextmenu", handleContextMenu, true);
    return () =>
      document.removeEventListener("contextmenu", handleContextMenu, true);
  }, [open]);

  useEffect(() => {
    setPhotoIndex(index);
    setRotation(0);
  }, [index]);

  // Preload adjacent photos for instant switching
  useEffect(() => {
    const RANGE = 2;
    const start = Math.max(0, photoIndex - RANGE);
    const end = Math.min(photos.length - 1, photoIndex + RANGE);
    for (let i = start; i <= end; i++) {
      if (i !== photoIndex) {
        const p = photos[i];
        preloadImage(p.thumbnailPath ?? p.path);
      }
    }
  }, [photoIndex, photos]);

  useEffect(() => {
    if (!open) {
      setPlaying(false);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }
  }, [open]);

  useEffect(() => {
    if (!playing && timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, [playing]);

  useEffect(() => {
    if (!(playing && open)) {
      return;
    }

    timerRef.current = setTimeout(() => {
      programmaticRef.current = true;
      setPhotoIndex((prev) => (prev + 1) % photos.length);
    }, delay);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [playing, delay, open, photos.length, photoIndex]);

  function resetIdleTimer() {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
    }
    idleTimerRef.current = setTimeout(() => {
      setOverlayVisible(false);
    }, 3000);
  }

  function clearIdleTimer() {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }

  function handleMouseMove(_e: MouseEvent) {
    setOverlayVisible(true);
    resetIdleTimer();
  }

  const togglePlay = useCallback(() => {
    setPlaying((p) => !p);
  }, []);

  const handleInfoNavigate = useCallback(
    (direction: "prev" | "next") => {
      setPhotoIndex((prev) => {
        if (direction === "prev") {
          return prev > 0 ? prev - 1 : photos.length - 1;
        }
        return (prev + 1) % photos.length;
      });
    },
    [photos.length]
  );

  const cycleDelay = useCallback(() => {
    const currentIdx = SLIDESHOW_DELAYS.findIndex((d) => d.value === delay);
    const nextIdx = (currentIdx + 1) % SLIDESHOW_DELAYS.length;
    setDelay(SLIDESHOW_DELAYS[nextIdx].value);
  }, [delay]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === " ") {
        e.preventDefault();
        e.stopImmediatePropagation();
        togglePlay();
      }
      if (e.key === "i" || e.key === "I") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setInfoPanelVisible((v) => !v);
      }
      if (e.key === "r" || e.key === "R") {
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
  }, [open, togglePlay]);

  useEffect(() => {
    if (!open) {
      setOverlayVisible(true);
      clearIdleTimer();
      return;
    }

    resetIdleTimer();

    document.addEventListener("mousemove", handleMouseMove);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      clearIdleTimer();
    };
  }, [open]);

  // Find yarl portal and create anchor div for rendering info panel inside portal.
  // Uses MutationObserver to survive fullscreen transitions that recreate portal DOM.
  useEffect(() => {
    if (!open) {
      setPanelAnchor(null);
      return;
    }

    let cancelled = false;
    let observer: MutationObserver | null = null;

    function ensureAnchor(): HTMLDivElement | null {
      const portal =
        document.querySelector<HTMLDivElement>(".yarl__fullscreen");
      if (!portal) {
        return null;
      }
      let anchor = portal.querySelector<HTMLDivElement>(
        ".photo-detail-panel-anchor"
      );
      if (!anchor) {
        anchor = document.createElement("div");
        anchor.className = "photo-detail-panel-anchor";
        portal.appendChild(anchor);
        // Re-watch after re-insertion
        observer?.disconnect();
        observer = watchPortal(portal);
      }
      return anchor;
    }

    function watchPortal(portal: HTMLElement): MutationObserver {
      const obs = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.removedNodes) {
            if (
              node instanceof HTMLElement &&
              node.classList.contains("photo-detail-panel-anchor")
            ) {
              const newAnchor = ensureAnchor();
              if (newAnchor && !cancelled) {
                setPanelAnchor(newAnchor);
              }
              return;
            }
          }
        }
      });
      obs.observe(portal, { childList: true });
      return obs;
    }

    function attach() {
      if (cancelled) {
        return;
      }
      const portal =
        document.querySelector<HTMLDivElement>(".yarl__fullscreen");
      if (portal) {
        const anchor = ensureAnchor();
        if (anchor) {
          if (!cancelled) {
            setPanelAnchor(anchor);
          }
          observer = watchPortal(portal);
        }
      } else {
        requestAnimationFrame(attach);
      }
    }
    attach();

    return () => {
      cancelled = true;
      observer?.disconnect();
      document.querySelector(".photo-detail-panel-anchor")?.remove();
    };
  }, [open]);

  const handleViewChange = useCallback(
    ({ index: newIndex }: { index: number }) => {
      if (programmaticRef.current) {
        programmaticRef.current = false;
        return;
      }
      setPhotoIndex(newIndex);
      setPlaying(false);
      setRotation(0);
    },
    []
  );

  const slides = useMemo(() => photos.map((p) => ({
    src: toLocalMediaUrl(p.path),
    alt: p.filename,
    title: p.filename,
    description: formatDimensions(p.width, p.height),
  })), [photos]);

  const currentDelayLabel =
    SLIDESHOW_DELAYS.find((d) => d.value === delay)?.label || "5s";

  // 稳定化 toolbar.buttons 引用，避免每次渲染重建数组
  const toolbarButtons = useMemo(() => [
    <button
      aria-label={t("photoDetail")}
      aria-pressed={infoPanelVisible}
      className="flex items-center justify-center rounded-[6px] p-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
      key="info-panel"
      onClick={() => setInfoPanelVisible((v) => !v)}
      title={t("photoDetail")}
      type="button"
    >
      <svg fill="none" height="20" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" width="20">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4" strokeLinecap="round" />
        <circle cx="12" cy="8" fill="currentColor" r="1" stroke="none" />
      </svg>
    </button>,
    <button
      aria-label={t("rotateLeft")}
      className="ml-1 flex items-center justify-center rounded-[6px] border-white/15 border-l py-2 pr-2 pl-3 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
      key="rotate-left"
      onClick={() => setRotation((prev) => (prev - 90) % 360)}
      title={t("rotateLeft")}
      type="button"
    >
      <svg fill="none" height="20" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="20">
        <path d="M2.5 2v6h6M2.66 15.57a10 10 0 1 0 .57-8.38" />
      </svg>
    </button>,
    <button
      aria-label={t("rotateRight")}
      className="flex items-center justify-center rounded-[6px] p-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
      key="rotate-right"
      onClick={() => setRotation((prev) => (prev + 90) % 360)}
      title={t("rotateRight")}
      type="button"
    >
      <svg fill="none" height="20" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="20">
        <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38" />
      </svg>
    </button>,
    <button
      aria-label={playing ? t("pause") : t("play")}
      aria-pressed={playing}
      className="ml-1 flex items-center justify-center rounded-[6px] border-white/15 border-l py-2 pr-2 pl-3 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
      key="slideshow-play"
      onClick={togglePlay}
      title={playing ? t("pauseSlideshow") : t("playSlideshow")}
      type="button"
    >
      {playing ? (
        <svg fill="currentColor" height="20" viewBox="0 0 24 24" width="20">
          <rect height="16" rx="1" width="6" x="5" y="4" />
          <rect height="16" rx="1" width="6" x="13" y="4" />
        </svg>
      ) : (
        <svg fill="currentColor" height="20" viewBox="0 0 24 24" width="20">
          <polygon points="5,3 19,12 5,21" />
        </svg>
      )}
    </button>,
    <button
      aria-label={t("slideshowInterval", { value: currentDelayLabel })}
      className="flex items-center justify-center rounded-[6px] px-2 py-2 font-medium text-[11px] text-white/70 transition-colors hover:bg-white/10 hover:text-white"
      key="slideshow-delay"
      onClick={cycleDelay}
      title={t("switchInterval")}
      type="button"
    >
      {currentDelayLabel}
    </button>,
    "fullscreen",
    "close",
  ], [
    t,
    playing,
    infoPanelVisible,
    currentDelayLabel,
    togglePlay,
    cycleDelay,
  ]);

  // 当旋转90度或270度时需要调整容器尺寸以适应屏幕
  const isRotated90or270 = rotation % 180 !== 0;

  const lightboxStyles = useMemo(() => {
    const fadeIn = {
      opacity: 1,
      pointerEvents: "auto" as const,
      transition: "opacity 150ms ease-in",
    };
    const fadeOut = {
      opacity: 0,
      pointerEvents: "none" as const,
      transition: "opacity 300ms ease-out",
    };
    const overlayStyle = overlayVisible ? fadeIn : fadeOut;

    return {
      container: { backgroundColor: "rgba(0, 0, 0, 0.94)" },
      toolbar: {
        margin: "10px",
        padding: "4px 6px",
        background: "rgba(12, 12, 14, 0.62)",
        border: "1px solid rgba(255, 255, 255, 0.1)",
        borderRadius: "10px",
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.28)",
        backdropFilter: "blur(14px) saturate(1.2)",
        ...overlayStyle,
      },
      slide: {
        padding: "0 60px",
        // 旋转90/270度时增加额外空间以防止溢出
        ...(isRotated90or270 ? { padding: "60px 0" } : {}),
      },
      captionsTitleContainer: {
        background:
          "linear-gradient(to bottom, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.15) 75%, transparent 100%)",
        padding: "10px 16px 10px 120px",
        ...overlayStyle,
      },
      captionsDescriptionContainer: {
        background:
          "linear-gradient(to top, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.15) 75%, transparent 100%)",
        padding: "10px 16px",
        ...overlayStyle,
      },
      thumbnail: { border: "2px solid transparent", borderRadius: 4 },
      thumbnailsTrack: { padding: "6px 0" },
    };
  }, [overlayVisible, isRotated90or270]);

  return (
    <>
      <Lightbox
        animation={{
          fade: 300,
          navigation: 250,
          swipe: 350,
          easing: {
            fade: "cubic-bezier(0.16, 1, 0.3, 1)",
            swipe: "cubic-bezier(0.16, 1, 0.3, 1)",
            navigation: "cubic-bezier(0.16, 1, 0.3, 1)",
          },
        }}
        captions={{ showToggle: true }}
        carousel={{
          finite: false,
          imageProps: {
            draggable: true,
            onDragStart: (e: React.DragEvent) => {
              e.preventDefault();
              // 缩放状态下不触发文件导出，留给 Zoom 插件做平移拖拽
              if ((zoomRef.current?.zoom ?? 1) > 1) {
                return;
              }
              const idx = photoIndexRef.current;
              const p = photosRef.current[idx];
              if (p) {
                (window as any).electronAPI?.startDrag?.(p.path);
              }
            },
            style: {
              transition: "none",
              transform: `rotate(${rotation}deg)`,
              // 旋转90/270度时限制尺寸以防止溢出
              maxWidth: isRotated90or270 ? "90vh" : "100%",
              maxHeight: isRotated90or270 ? "90vw" : "100%",
              objectFit: "contain",
            },
          },
        }}
        close={() => onClose(photoIndex)}
        index={photoIndex}
        on={{ view: handleViewChange }}
        open={open}
        plugins={[Captions, Counter, Fullscreen, Thumbnails, Zoom]}
        slides={slides}
        styles={lightboxStyles}
        thumbnails={{
          width: 60,
          height: 40,
          gap: 4,
          borderRadius: 4,
          border: 0,
          showToggle: true,
        }}
        toolbar={{ buttons: toolbarButtons }}
        zoom={{
          ref: zoomRef,
          maxZoomPixelRatio: 5,
          scrollToZoom: true,
        }}
      />
      {infoPanelVisible &&
        panelAnchor &&
        createPortal(
          <div className="fixed top-0 right-0 z-[10000] h-full">
            <PhotoDetailPanel
              onClose={() => setInfoPanelVisible(false)}
              onNavigate={handleInfoNavigate}
              onOpenExplorer={async (path) => {
                await ipc.client.shell.openInExplorer({ path });
              }}
              photo={photos[photoIndex]}
            />
          </div>,
          panelAnchor
        )}
      <PreviewContextMenu
        menu={previewMenu}
        onClose={() => setPreviewMenu((prev) => ({ ...prev, open: false }))}
        onOpenExplorer={async (path) => {
          await ipc.client.shell.openInExplorer({ path });
        }}
      />
    </>
  );
});
