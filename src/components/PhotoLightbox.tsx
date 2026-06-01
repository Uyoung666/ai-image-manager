import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import Lightbox from "yet-another-react-lightbox";
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
import { preloadImage, toLocalMediaUrl } from "@/utils/local-media-url";
import { PhotoDetailPanel } from "@/components/PhotoDetailPanel";
import { ipc } from "@/ipc/manager";

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

export function PhotoLightbox({
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
  const [overlayVisible, setOverlayVisible] = useState(true);
  const [infoPanelVisible, setInfoPanelVisible] = useState(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [panelAnchor, setPanelAnchor] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    setPhotoIndex(index);
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
        if (direction === "prev") return prev > 0 ? prev - 1 : photos.length - 1;
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
    if (!open) return;
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
      const portal = document.querySelector<HTMLDivElement>(".yarl__fullscreen");
      if (!portal) return null;
      let anchor = portal.querySelector<HTMLDivElement>(".photo-detail-panel-anchor");
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
            if (node instanceof HTMLElement && node.classList.contains("photo-detail-panel-anchor")) {
              const newAnchor = ensureAnchor();
              if (newAnchor && !cancelled) setPanelAnchor(newAnchor);
              return;
            }
          }
        }
      });
      obs.observe(portal, { childList: true });
      return obs;
    }

    function attach() {
      if (cancelled) return;
      const portal = document.querySelector<HTMLDivElement>(".yarl__fullscreen");
      if (portal) {
        const anchor = ensureAnchor();
        if (anchor) {
          if (!cancelled) setPanelAnchor(anchor);
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
    },
    []
  );

  const slides = photos.map((p) => ({
    src: toLocalMediaUrl(p.path),
    alt: p.filename,
    title: p.filename,
    description: formatDimensions(p.width, p.height),
  }));

  const currentDelayLabel =
    SLIDESHOW_DELAYS.find((d) => d.value === delay)?.label || "5s";

  const lightboxStyles = useMemo(() => {
    const fadeIn = { opacity: 1, pointerEvents: "auto" as const, transition: "opacity 150ms ease-in" };
    const fadeOut = { opacity: 0, pointerEvents: "none" as const, transition: "opacity 300ms ease-out" };
    const overlayStyle = overlayVisible ? fadeIn : fadeOut;

    return {
      container: { backgroundColor: "rgba(0, 0, 0, 0.94)" },
      toolbar: { padding: "8px 12px", ...overlayStyle },
      slide: { padding: "0 60px" },
      captionsTitleContainer: {
        background: "linear-gradient(to bottom, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.15) 75%, transparent 100%)",
        padding: "10px 16px 10px 120px",
        ...overlayStyle,
      },
      captionsDescriptionContainer: {
        background: "linear-gradient(to top, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.15) 75%, transparent 100%)",
        padding: "10px 16px",
        ...overlayStyle,
      },
      thumbnail: { border: "2px solid transparent", borderRadius: 4 },
      thumbnailsTrack: { padding: "6px 0" }
    };
  }, [overlayVisible]);

  return (
    <>
      <Lightbox
        animation={{ navigation: 0 }}
        carousel={{
          finite: false,
          imageProps: { style: { transition: "none" } },
        }}
        close={() => onClose(photoIndex)}
        index={photoIndex}
        on={{ view: handleViewChange }}
        open={open}
        captions={{ showToggle: true }}
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
      toolbar={{
        buttons: [
          <button
            aria-label={t("photoDetail")}
            className="flex items-center justify-center rounded-[6px] p-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            key="info-panel"
            onClick={() => setInfoPanelVisible((v) => !v)}
            title={t("photoDetail")}
            type="button"
          >
            <svg
              fill="none"
              height="20"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
              width="20"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M12 16v-4" strokeLinecap="round" />
              <circle cx="12" cy="8" r="1" fill="currentColor" stroke="none" />
            </svg>
          </button>,
          <button
            aria-label={playing ? t("pause") : t("play")}
            className="flex items-center justify-center rounded-[6px] p-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            key="slideshow-play"
            onClick={togglePlay}
            title={playing ? t("pauseSlideshow") : t("playSlideshow")}
            type="button"
          >
            {playing ? (
              <svg
                fill="currentColor"
                height="20"
                viewBox="0 0 24 24"
                width="20"
              >
                <rect height="16" rx="1" width="6" x="5" y="4" />
                <rect height="16" rx="1" width="6" x="13" y="4" />
              </svg>
            ) : (
              <svg
                fill="currentColor"
                height="20"
                viewBox="0 0 24 24"
                width="20"
              >
                <polygon points="5,3 19,12 5,21" />
              </svg>
            )}
          </button>,
          <button
            aria-label={t("slideshowInterval", { value: currentDelayLabel })}
            className="flex items-center justify-center rounded-[6px] px-2 py-2 font-[510] text-[11px] text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            key="slideshow-delay"
            onClick={cycleDelay}
            title={t("switchInterval")}
            type="button"
          >
            {currentDelayLabel}
          </button>,
          "fullscreen",
          "close",
        ],
      }}
      zoom={{
        maxZoomPixelRatio: 5,
        scrollToZoom: true,
      }}
    />
      {infoPanelVisible && panelAnchor && createPortal(
        <div className="fixed top-0 right-0 z-[10000] h-full">
          <PhotoDetailPanel
            photo={photos[photoIndex]}
            onClose={() => setInfoPanelVisible(false)}
            onNavigate={handleInfoNavigate}
            onOpenExplorer={async (path) => {
              await ipc.client.shell.openInExplorer({ path });
            }}
          />
        </div>,
        panelAnchor
      )}
    </>
  );
}
