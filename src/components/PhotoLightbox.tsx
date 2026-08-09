import {
  ChevronLeft,
  ChevronRight,
  Copy,
  FolderOpen,
  Image as ImageIcon,
  Info,
  Maximize,
  Minimize,
  Minus,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RotateCcw,
  RotateCw,
  Rows3,
  Star,
  X,
} from "lucide-react";
import {
  memo,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { wanderActions } from "@/actions/wander";
import {
  LightboxInfoPanel,
  type LightboxInfoPhoto,
} from "@/components/LightboxInfoPanel";
import {
  PreviewContextMenu,
  type PreviewMenuState,
} from "@/components/PreviewContextMenu";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { ipc } from "@/ipc/manager";
import { preloadImage, toLocalMediaUrl } from "@/utils/local-media-url";

export interface LightboxPhoto extends LightboxInfoPhoto {
  isFavorite?: boolean | null;
  thumbnailPath?: string | null;
}

interface PhotoLightboxProps {
  autoPlay?: boolean;
  initialIndex: number;
  modalOpen?: boolean;
  onAddToAlbum?: (photoId: number) => void;
  onClose: (result: { index: number; photoId: number }) => void;
  onToggleFavorite?: (photoId: number, nextFavorite: boolean) => Promise<void>;
  open: boolean;
  photos: LightboxPhoto[];
  sequencePlayback?: boolean;
  showThumbnailsInitially?: boolean;
}

const SLIDESHOW_DELAYS = [3000, 5000, 10_000] as const;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.2;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function getFocusableElements(root: HTMLElement) {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the viewer intentionally coordinates its mutually constrained review modes in one owner.
export const PhotoLightbox = memo(function PhotoLightbox({
  photos,
  initialIndex,
  modalOpen = false,
  open,
  onClose,
  onToggleFavorite,
  onAddToAlbum,
  showThumbnailsInitially = false,
  sequencePlayback = false,
  autoPlay = false,
}: PhotoLightboxProps) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wheelFrameRef = useRef<number | null>(null);
  const wheelStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wheelZoomRef = useRef(1);
  const wheelActiveRef = useRef(false);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const focusFrameRef = useRef<number | null>(null);
  const currentPhotoIdRef = useRef<number | null>(null);
  const thumbnailRefs = useRef(new Map<number, HTMLButtonElement>());
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    translateX: number;
    translateY: number;
  } | null>(null);

  const [photoIndex, setPhotoIndex] = useState(initialIndex);
  const [zoom, setZoom] = useState(1);
  const [wheelActive, setWheelActive] = useState(false);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0);
  const [canvasSize, setCanvasSize] = useState({ height: 0, width: 0 });
  const [loaded, setLoaded] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [sourceKey, setSourceKey] = useState(0);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [infoVisible, setInfoVisible] = useState(false);
  const [thumbnailsVisible, setThumbnailsVisible] = useState(false);

  useEffect(() => {
    if (open && showThumbnailsInitially) {
      setThumbnailsVisible(true);
    }
  }, [open, showThumbnailsInitially]);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreAnchorRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [slideshowMode, setSlideshowMode] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [delay, setDelay] = useState<number>(sequencePlayback ? 167 : 5000);
  const playbackDelays = sequencePlayback ? [500, 167, 83] : SLIDESHOW_DELAYS;
  const [progress, setProgress] = useState(0);
  const [favoriteOverrides, setFavoriteOverrides] = useState<
    Record<number, boolean>
  >({});
  const [favoriteSaving, setFavoriteSaving] = useState(false);
  const [wrapPulse, setWrapPulse] = useState(false);
  const [previewMenu, setPreviewMenu] = useState<PreviewMenuState>({
    open: false,
    photoPath: null,
    x: 0,
    y: 0,
  });

  const safeIndex = photos.length ? clamp(photoIndex, 0, photos.length - 1) : 0;
  const photo = photos[safeIndex];
  const previewPlayback = sequencePlayback && slideshowMode && playing;
  const previewUrl = photo?.thumbnailPath
    ? toLocalMediaUrl(photo.thumbnailPath)
    : null;
  currentPhotoIdRef.current = photo?.id ?? null;
  const favorite = photo
    ? (favoriteOverrides[photo.id] ?? Boolean(photo.isFavorite))
    : false;

  useEffect(() => {
    setLoaded(false);
    setImageError(false);
  }, []);

  useEffect(() => {
    if (!(open && photo)) {
      return;
    }
    const timeout = window.setTimeout(() => {
      wanderActions
        .recordExposure({ photoId: photo.id, source: "lightbox" })
        .catch(() => undefined);
    }, 2000);
    return () => window.clearTimeout(timeout);
  }, [open, photo]);

  const resetView = useCallback(() => {
    wheelZoomRef.current = 1;
    setZoom(1);
    setTranslate({ x: 0, y: 0 });
    setRotation(0);
  }, []);

  const requestClose = useCallback(() => {
    const current = photos[safeIndex];
    if (!current) {
      return;
    }
    onClose({ index: safeIndex, photoId: current.id });
  }, [onClose, photos, safeIndex]);

  const navigate = useCallback(
    (direction: -1 | 1, manual = true) => {
      if (photos.length <= 1) {
        return;
      }
      setPhotoIndex((previous) => {
        const next = (previous + direction + photos.length) % photos.length;
        if (
          (direction === 1 && previous === photos.length - 1) ||
          (direction === -1 && previous === 0)
        ) {
          if (!reduceMotion) {
            setWrapPulse(true);
          }
          window.setTimeout(() => setWrapPulse(false), 450);
        }
        return next;
      });
      resetView();
      setLoaded(false);
      setImageError(false);
      setMoreOpen(false);
      if (manual) {
        setPlaying(false);
      }
    },
    [photos.length, reduceMotion, resetView]
  );

  const updateZoom = useCallback((next: number, manual = true) => {
    const value = clamp(next, 1, MAX_ZOOM);
    wheelZoomRef.current = value;
    setZoom(value);
    if (value <= 1.001) {
      setTranslate({ x: 0, y: 0 });
    }
    if (manual) {
      setPlaying(false);
    }
  }, []);

  const handleWheelZoom = useCallback(
    (event: ReactWheelEvent<HTMLImageElement>) => {
      event.preventDefault();
      let modeMultiplier = 1;
      if (event.deltaMode === 1) {
        modeMultiplier = 16;
      } else if (event.deltaMode === 2) {
        modeMultiplier = window.innerHeight;
      }
      const delta = clamp(event.deltaY * modeMultiplier, -120, 120);
      const next = clamp(
        wheelZoomRef.current * Math.exp(-delta * 0.0018),
        1,
        MAX_ZOOM
      );
      wheelZoomRef.current = next;

      if (!wheelActiveRef.current) {
        wheelActiveRef.current = true;
        setWheelActive(true);
      }
      if (wheelFrameRef.current === null) {
        wheelFrameRef.current = requestAnimationFrame(() => {
          wheelFrameRef.current = null;
          const value = wheelZoomRef.current;
          setZoom(value);
          if (value <= 1.001) {
            setTranslate({ x: 0, y: 0 });
          }
        });
      }
      if (wheelStopTimerRef.current) {
        clearTimeout(wheelStopTimerRef.current);
      }
      wheelStopTimerRef.current = setTimeout(() => {
        wheelActiveRef.current = false;
        setWheelActive(false);
      }, 120);
      setPlaying(false);
    },
    []
  );

  const showActualPixels = useCallback(() => {
    const image = imageRef.current;
    if (!image?.clientWidth) {
      return;
    }
    updateZoom(clamp(image.naturalWidth / image.clientWidth, 1, MAX_ZOOM));
  }, [updateZoom]);

  const toggleInfo = useCallback(() => {
    setInfoVisible((visible) => {
      if (!visible) {
        setThumbnailsVisible(false);
      }
      return !visible;
    });
    setPlaying(false);
    setMoreOpen(false);
  }, []);

  const toggleThumbnails = useCallback(() => {
    if (photos.length <= 1) {
      return;
    }
    setThumbnailsVisible((visible) => {
      if (!visible) {
        setInfoVisible(false);
      }
      return !visible;
    });
    setMoreOpen(false);
  }, [photos.length]);

  const toggleFavorite = useCallback(async () => {
    if (!(photo && onToggleFavorite) || favoriteSaving) {
      return;
    }
    const previous = favorite;
    const next = !previous;
    setFavoriteOverrides((values) => ({ ...values, [photo.id]: next }));
    setFavoriteSaving(true);
    try {
      await onToggleFavorite(photo.id, next);
    } catch {
      setFavoriteOverrides((values) => ({ ...values, [photo.id]: previous }));
      toast.error(t("favoriteUpdateFailed"));
    } finally {
      setFavoriteSaving(false);
    }
  }, [favorite, favoriteSaving, onToggleFavorite, photo, t]);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await rootRef.current?.requestFullscreen();
      }
    } catch {
      toast.error(t("fullscreenFailed"));
    }
  }, [t]);

  const startSlideshow = useCallback(() => {
    setSlideshowMode(true);
    setPlaying(true);
    setInfoVisible(false);
    setThumbnailsVisible(false);
    setMoreOpen(false);
  }, []);

  const stopSlideshow = useCallback(() => {
    setPlaying(false);
    setSlideshowMode(false);
    setProgress(0);
  }, []);

  const canAutoHide = !(
    infoVisible ||
    thumbnailsVisible ||
    moreOpen ||
    modalOpen ||
    previewMenu.open ||
    (slideshowMode && !playing)
  );

  const revealControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
    }
    if (canAutoHide) {
      hideTimerRef.current = setTimeout(() => setControlsVisible(false), 3000);
    }
  }, [canAutoHide]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setPhotoIndex(initialIndex);
    resetView();
    setLoaded(false);
    setImageError(false);
    setControlsVisible(true);
    setInfoVisible(false);
    setThumbnailsVisible(false);
    setMoreOpen(false);
    setSlideshowMode(autoPlay);
    setPlaying(autoPlay);
    setProgress(0);
    setFavoriteOverrides({});
  }, [autoPlay, initialIndex, open, resetView]);

  useEffect(() => {
    const id = currentPhotoIdRef.current;
    if (!(open && id != null && photos.length)) {
      return;
    }
    const nextIndex = photos.findIndex((item) => item.id === id);
    if (nextIndex >= 0 && nextIndex !== photoIndex) {
      setPhotoIndex(nextIndex);
    } else if (nextIndex < 0) {
      setPhotoIndex((value) => clamp(value, 0, photos.length - 1));
    }
  }, [open, photoIndex, photos]);

  useEffect(() => {
    if (!(open && photo)) {
      return;
    }
    const ahead = previewPlayback ? 12 : 2;
    const behind = previewPlayback ? 1 : 2;
    const preloadedIndices = new Set<number>();
    for (let offset = -behind; offset <= ahead; offset += 1) {
      const index = (safeIndex + offset + photos.length) % photos.length;
      if (index === safeIndex || preloadedIndices.has(index)) {
        continue;
      }
      preloadedIndices.add(index);
      preloadImage(photos[index].thumbnailPath ?? photos[index].path);
    }
  }, [open, photo, photos, previewPlayback, safeIndex]);

  useEffect(() => {
    if (!(open && thumbnailsVisible && photo)) {
      return;
    }
    thumbnailRefs.current.get(photo.id)?.scrollIntoView?.({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "nearest",
      inline: "center",
    });
  }, [open, photo, reduceMotion, thumbnailsVisible]);

  useEffect(() => {
    if (!open) {
      return;
    }
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = null;
      rootRef.current?.focus();
    });
    return () => {
      if (focusFrameRef.current !== null) {
        cancelAnimationFrame(focusFrameRef.current);
        focusFrameRef.current = null;
      }
      document.body.style.overflow = previousOverflow;
      const previousFocus = previousFocusRef.current;
      previousFocusRef.current = null;
      if (previousFocus?.isConnected) {
        previousFocus.focus();
      }
    };
  }, [open]);

  useEffect(() => {
    const handler = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const update = () => {
      setCanvasSize({ height: canvas.clientHeight, width: canvas.clientWidth });
    };
    update();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(update);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    revealControls();
    return () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
      }
      if (wheelFrameRef.current !== null) {
        cancelAnimationFrame(wheelFrameRef.current);
        wheelFrameRef.current = null;
      }
      if (wheelStopTimerRef.current) {
        clearTimeout(wheelStopTimerRef.current);
      }
      wheelActiveRef.current = false;
    };
  }, [open, revealControls]);

  useEffect(() => {
    if (!(open && slideshowMode && playing && photos.length > 1)) {
      return;
    }
    const started = performance.now();
    setProgress(0);
    const interval = window.setInterval(() => {
      setProgress(clamp((performance.now() - started) / delay, 0, 1));
    }, 100);
    const timeout = window.setTimeout(() => {
      if (photoIndex < photos.length) {
        navigate(1, false);
      }
    }, delay);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [
    delay,
    navigate,
    open,
    photoIndex,
    photos.length,
    playing,
    slideshowMode,
  ]);

  useEffect(() => {
    if (!open) {
      return;
    }
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the flat shortcut dispatcher keeps precedence and propagation rules auditable.
    const keydown = (event: KeyboardEvent) => {
      if (modalOpen) {
        return;
      }
      if (isEditableTarget(event.target)) {
        return;
      }
      if (event.key === "Tab") {
        const root = rootRef.current;
        if (root) {
          const focusable = getFocusableElements(root);
          if (focusable.length === 0) {
            event.preventDefault();
            root.focus();
          } else {
            const currentIndex = focusable.indexOf(
              document.activeElement as HTMLElement
            );
            let nextIndex: number;
            if (event.shiftKey) {
              nextIndex =
                currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1;
            } else {
              nextIndex =
                currentIndex === focusable.length - 1 ? 0 : currentIndex + 1;
            }
            event.preventDefault();
            focusable[nextIndex]?.focus();
          }
        }
        revealControls();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (previewMenu.open) {
          setPreviewMenu((value) => ({ ...value, open: false }));
        } else if (moreOpen) {
          setMoreOpen(false);
        } else if (infoVisible) {
          setInfoVisible(false);
        } else if (thumbnailsVisible) {
          setThumbnailsVisible(false);
        } else if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => undefined);
        } else {
          requestClose();
        }
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        event.stopImmediatePropagation();
        navigate(event.key === "ArrowLeft" ? -1 : 1);
      } else if (event.key === " ") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (slideshowMode) {
          setPlaying((value) => !value);
        } else {
          startSlideshow();
        }
      } else if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        event.stopImmediatePropagation();
        toggleFavorite();
      } else if (event.key.toLowerCase() === "i") {
        event.preventDefault();
        event.stopImmediatePropagation();
        toggleInfo();
      } else if (event.key.toLowerCase() === "t") {
        event.preventDefault();
        event.stopImmediatePropagation();
        toggleThumbnails();
      } else if (event.key.toLowerCase() === "r") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setRotation((value) => value + (event.shiftKey ? -90 : 90));
        setPlaying(false);
      } else if (event.key === "0") {
        event.preventDefault();
        updateZoom(1);
      } else if (event.key === "1") {
        event.preventDefault();
        showActualPixels();
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        updateZoom(zoom * ZOOM_STEP);
      } else if (event.key === "-") {
        event.preventDefault();
        updateZoom(zoom / ZOOM_STEP);
      }
      revealControls();
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [
    infoVisible,
    moreOpen,
    modalOpen,
    navigate,
    open,
    previewMenu.open,
    requestClose,
    revealControls,
    showActualPixels,
    slideshowMode,
    startSlideshow,
    thumbnailsVisible,
    toggleFavorite,
    toggleInfo,
    toggleThumbnails,
    updateZoom,
    zoom,
  ]);

  const chromeClass = controlsVisible
    ? "pointer-events-auto opacity-100"
    : "pointer-events-none opacity-0";
  const zoomLabel = `${Math.round(zoom * 100)}%`;
  const isQuarterTurn = Math.abs(rotation % 180) === 90;
  const thumbnailItems = useMemo(
    () =>
      photos.map((item, index) => ({
        item,
        index,
        src: toLocalMediaUrl(item.thumbnailPath ?? item.path),
      })),
    [photos]
  );

  if (!(open && photo && photos.length)) {
    return null;
  }

  return createPortal(
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: the modal dialog surface owns global reveal and image context-menu interactions.
    <div
      aria-label={t("lightboxReview")}
      aria-modal="true"
      className={`lightbox-interactive fixed inset-0 z-[1000] flex overflow-hidden bg-[#09090b] text-white outline-none ${controlsVisible ? "cursor-default" : "cursor-none"}`}
      onContextMenu={(event) => {
        const target = event.target as HTMLElement;
        if (!target.closest("[data-lightbox-image]")) {
          return;
        }
        event.preventDefault();
        setPreviewMenu({
          open: true,
          photoPath: photo.path,
          x: event.clientX,
          y: event.clientY,
        });
      }}
      onFocusCapture={revealControls}
      onMouseMove={revealControls}
      ref={rootRef}
      role="dialog"
      tabIndex={-1}
    >
      <div className="relative min-w-0 flex-1 overflow-hidden">
        <div
          className="absolute inset-x-0 top-0 z-20 h-20 bg-gradient-to-b from-black/75 to-transparent transition-opacity duration-200 motion-reduce:transition-none"
          data-lightbox-chrome
          style={{ opacity: controlsVisible ? 1 : 0 }}
        />
        <header
          className={`absolute inset-x-0 top-0 z-30 flex h-14 min-w-0 items-center justify-between gap-2 px-2 transition-opacity duration-200 motion-reduce:transition-none sm:gap-5 sm:px-4 ${chromeClass}`}
        >
          <div className="flex min-w-0 items-center gap-3">
            <span
              className={`shrink-0 rounded-full bg-white/10 px-2.5 py-1 text-[11px] text-white/70 transition-transform ${wrapPulse ? "scale-110" : "scale-100"}`}
            >
              {safeIndex + 1} / {photos.length}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className="truncate font-medium text-[13px] text-white/85"
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: truncated filename must expose its Tooltip to keyboard users
                  tabIndex={0}
                >
                  {photo.filename}
                </span>
              </TooltipTrigger>
              <TooltipContent>{photo.filename}</TooltipContent>
            </Tooltip>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {onToggleFavorite && (
              <ControlButton
                active={favorite}
                disabled={favoriteSaving}
                label={favorite ? t("unfavorite") : t("favorite")}
                onClick={toggleFavorite}
              >
                <Star
                  className={`h-4 w-4 ${favorite ? "fill-amber-400 text-amber-400" : ""}`}
                />
              </ControlButton>
            )}
            <ControlButton
              active={infoVisible}
              label={t("photoDetail")}
              onClick={toggleInfo}
            >
              <Info className="h-4 w-4" />
            </ControlButton>
            <Popover onOpenChange={setMoreOpen} open={moreOpen}>
              <PopoverAnchor asChild>
                <div ref={moreAnchorRef}>
                  <ControlButton
                    active={moreOpen}
                    label={t("more")}
                    onClick={() => setMoreOpen((value) => !value)}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </ControlButton>
                </div>
              </PopoverAnchor>
              {moreOpen && (
                <PopoverContent
                  align="end"
                  className="z-[1100] max-h-[min(20rem,var(--radix-popover-content-available-height))] w-56 max-w-[calc(100vw-1rem)] gap-0 overflow-y-auto overscroll-contain rounded-lg border border-white/10 bg-[#1a1a1e]/95 p-1.5 text-white shadow-2xl backdrop-blur-xl"
                  collisionPadding={8}
                  onCloseAutoFocus={(event) => event.preventDefault()}
                  onInteractOutside={(event) => {
                    if (
                      event.target instanceof Node &&
                      moreAnchorRef.current?.contains(event.target)
                    ) {
                      event.preventDefault();
                    }
                  }}
                  sideOffset={6}
                >
                  {onAddToAlbum && (
                    <MenuButton
                      icon={<Rows3 className="h-4 w-4" />}
                      label={t("addToAlbum")}
                      onClick={() => {
                        setMoreOpen(false);
                        onAddToAlbum(photo.id);
                      }}
                    />
                  )}
                  <MenuButton
                    icon={<Play className="h-4 w-4" />}
                    label={t("playSlideshow")}
                    onClick={startSlideshow}
                  />
                  <div className="my-1 border-white/10 border-t" />
                  <MenuButton
                    icon={<ImageIcon className="h-4 w-4" />}
                    label={t("copyImage")}
                    onClick={async () => {
                      const ok =
                        await window.electronAPI?.copyImageToClipboard?.(
                          photo.path
                        );
                      if (ok) {
                        toast.success(t("imageCopiedToClipboard"));
                      }
                      setMoreOpen(false);
                    }}
                  />
                  <MenuButton
                    icon={<Copy className="h-4 w-4" />}
                    label={t("copyPath")}
                    onClick={() => {
                      navigator.clipboard
                        .writeText(photo.path)
                        .catch(() => undefined);
                      setMoreOpen(false);
                    }}
                  />
                  <MenuButton
                    icon={<FolderOpen className="h-4 w-4" />}
                    label={t("openInExplorer")}
                    onClick={() => {
                      ipc.client.shell
                        .openInExplorer({ path: photo.path })
                        .catch(() => undefined);
                      setMoreOpen(false);
                    }}
                  />
                </PopoverContent>
              )}
            </Popover>
            <ControlButton
              active={isFullscreen}
              label={isFullscreen ? t("exitFullscreen") : t("fullscreen")}
              onClick={toggleFullscreen}
            >
              {isFullscreen ? (
                <Minimize className="h-4 w-4" />
              ) : (
                <Maximize className="h-4 w-4" />
              )}
            </ControlButton>
            <ControlButton label={t("close")} onClick={requestClose}>
              <X className="h-5 w-5" />
            </ControlButton>
          </div>
        </header>

        <div
          className="absolute inset-x-0 top-0 flex items-center justify-center overflow-hidden px-10 pt-14 pb-16 transition-[bottom] duration-200 motion-reduce:transition-none sm:px-16"
          ref={canvasRef}
          style={{ bottom: thumbnailsVisible ? 96 : 0 }}
        >
          {imageError ? (
            <div className="flex max-w-sm flex-col items-center gap-3 text-center">
              <ImageIcon className="h-10 w-10 text-white/25" />
              <p className="text-[13px] text-white/65">
                {t("imageLoadFailed")}
              </p>
              <Tooltip>
                <TooltipTrigger asChild>
                  <p className="max-w-full truncate text-[11px] text-white/35">
                    {photo.filename}
                  </p>
                </TooltipTrigger>
                <TooltipContent className="max-w-[min(28rem,calc(100vw-1rem))] break-all">
                  {photo.filename}
                </TooltipContent>
              </Tooltip>
              <div className="flex flex-wrap justify-center gap-2">
                <button
                  className="lightbox-secondary-button"
                  onClick={() => {
                    setImageError(false);
                    setLoaded(false);
                    setSourceKey((value) => value + 1);
                  }}
                  type="button"
                >
                  {t("retry")}
                </button>
                <button
                  className="lightbox-secondary-button"
                  onClick={() => {
                    ipc.client.shell
                      .openInExplorer({ path: photo.path })
                      .catch(() => undefined);
                  }}
                  type="button"
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  {t("openInExplorer")}
                </button>
              </div>
            </div>
          ) : // biome-ignore lint/style/noNestedTernary: the mutually exclusive error, playback, and original-image surfaces keep only one frame mounted.
          previewPlayback && previewUrl ? (
            // biome-ignore lint/a11y/noNoninteractiveElementInteractions: the playback image retains error handling for unavailable thumbnails.
            <img
              alt={photo.filename}
              className="max-h-full max-w-full select-none object-contain"
              data-lightbox-image
              data-lightbox-playback-frame
              draggable={false}
              height={photo.height || undefined}
              onError={() => {
                setImageError(true);
                setLoaded(false);
              }}
              src={previewUrl}
              width={photo.width || undefined}
            />
          ) : (
            // biome-ignore lint/a11y/noNoninteractiveElementInteractions: the reviewed image is directly pannable, zoomable, draggable, and context-menu enabled.
            <img
              alt={photo.filename}
              className={`max-h-full max-w-full select-none object-contain transition-opacity duration-150 motion-reduce:transition-none ${loaded ? "opacity-100" : "opacity-0"} ${zoom > 1 ? "cursor-grab active:cursor-grabbing" : ""}`}
              data-lightbox-image
              draggable={zoom <= 1}
              height={photo.height || undefined}
              key={`${photo.id}-${sourceKey}`}
              onDoubleClick={() => {
                if (zoom > 1.05) {
                  updateZoom(1);
                } else {
                  showActualPixels();
                }
              }}
              onDragStart={(event) => {
                event.preventDefault();
                if (zoom > 1) {
                  return;
                }
                window.electronAPI?.startDrag?.(photo.path);
              }}
              onError={() => {
                setImageError(true);
                setLoaded(false);
              }}
              onLoad={() => setLoaded(true)}
              onPointerDown={(event) => {
                if (zoom <= 1) {
                  return;
                }
                event.currentTarget.setPointerCapture(event.pointerId);
                dragRef.current = {
                  pointerId: event.pointerId,
                  startX: event.clientX,
                  startY: event.clientY,
                  translateX: translate.x,
                  translateY: translate.y,
                };
              }}
              onPointerMove={(event) => {
                const drag = dragRef.current;
                if (!drag || drag.pointerId !== event.pointerId) {
                  return;
                }
                setTranslate({
                  x: drag.translateX + event.clientX - drag.startX,
                  y: drag.translateY + event.clientY - drag.startY,
                });
              }}
              onPointerUp={(event) => {
                if (dragRef.current?.pointerId === event.pointerId) {
                  dragRef.current = null;
                }
              }}
              onWheel={handleWheelZoom}
              ref={imageRef}
              src={toLocalMediaUrl(photo.path)}
              style={{
                maxHeight:
                  isQuarterTurn && canvasSize.width
                    ? `${Math.max(1, canvasSize.width - 128)}px`
                    : undefined,
                maxWidth:
                  isQuarterTurn && canvasSize.height
                    ? `${Math.max(1, canvasSize.height - 112)}px`
                    : undefined,
                transform: `translate3d(${translate.x}px, ${translate.y}px, 0) scale(${zoom}) rotate(${rotation}deg)`,
                backfaceVisibility: "hidden",
                transition:
                  reduceMotion || dragRef.current || wheelActive
                    ? "none"
                    : "transform 150ms cubic-bezier(0.16, 1, 0.3, 1)",
                willChange: "transform",
              }}
              width={photo.width || undefined}
            />
          )}
          {!((previewPlayback && previewUrl) || loaded || imageError) && (
            <div className="absolute inset-0 flex items-center justify-center">
              <LoadingSpinner
                aria-label={t("loading")}
                data-reduced-motion-keep="spinner"
                size="lg"
                variant="overlay"
              />
            </div>
          )}
        </div>

        {photos.length > 1 && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  aria-label={t("previousPhoto")}
                  className={`group absolute top-14 bottom-16 left-0 z-10 flex w-10 items-center justify-center transition-opacity duration-200 sm:w-16 ${chromeClass}`}
                  onClick={() => navigate(-1)}
                  type="button"
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-black/35 text-white/60 opacity-40 transition-all group-hover:bg-black/70 group-hover:text-white group-hover:opacity-100">
                    <ChevronLeft className="h-6 w-6" />
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent>{t("previousPhoto")}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  aria-label={t("nextPhoto")}
                  className={`group absolute top-14 right-0 bottom-16 z-10 flex w-10 items-center justify-center transition-opacity duration-200 sm:w-16 ${chromeClass}`}
                  onClick={() => navigate(1)}
                  type="button"
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-black/35 text-white/60 opacity-40 transition-all group-hover:bg-black/70 group-hover:text-white group-hover:opacity-100">
                    <ChevronRight className="h-6 w-6" />
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent>{t("nextPhoto")}</TooltipContent>
            </Tooltip>
          </>
        )}

        <div
          className={`absolute inset-x-0 z-30 flex justify-center overflow-hidden px-2 transition-[bottom,opacity] duration-200 motion-reduce:transition-none ${chromeClass}`}
          style={{ bottom: thumbnailsVisible ? 108 : 12 }}
        >
          {slideshowMode ? (
            <div className="relative flex max-w-full items-center gap-1 overflow-x-auto overscroll-x-contain rounded-xl border border-white/10 bg-black/65 p-1.5 shadow-2xl backdrop-blur-xl">
              <div
                className="absolute bottom-0 left-0 h-0.5 bg-primary transition-[width] duration-100"
                data-reduced-motion-keep="progress-bar"
                style={{ width: `${progress * 100}%` }}
              />
              <ControlButton
                label={playing ? t("pauseSlideshow") : t("playSlideshow")}
                onClick={() => setPlaying((value) => !value)}
              >
                {playing ? (
                  <Pause className="h-4 w-4" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
              </ControlButton>
              {playbackDelays.map((value) => (
                <button
                  className={`rounded-md px-2 py-1.5 text-[11px] transition-colors ${delay === value ? "bg-white/15 text-white" : "text-white/50 hover:bg-white/10 hover:text-white"}`}
                  key={value}
                  onClick={() => {
                    setDelay(value);
                    setProgress(0);
                  }}
                  type="button"
                >
                  {sequencePlayback
                    ? `${Math.round(1000 / value)} fps`
                    : `${value / 1000}s`}
                </button>
              ))}
              <div className="mx-1 h-5 border-white/10 border-l" />
              <button
                className="lightbox-control-button gap-1.5 px-2.5 text-[11px]"
                onClick={stopSlideshow}
                type="button"
              >
                <X className="h-3.5 w-3.5" />
                {t("exitSlideshow")}
              </button>
            </div>
          ) : (
            <div className="flex max-w-full items-center gap-0.5 overflow-x-auto overscroll-x-contain rounded-xl border border-white/10 bg-black/65 p-1.5 shadow-2xl backdrop-blur-xl">
              <ControlButton
                label={t("zoomOut")}
                onClick={() => updateZoom(zoom / ZOOM_STEP)}
              >
                <Minus className="h-4 w-4" />
              </ControlButton>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    aria-label={t("fitToScreen")}
                    className="min-w-14 rounded-md px-2 py-2 text-[11px] text-white/70 tabular-nums hover:bg-white/10 hover:text-white"
                    onClick={() => updateZoom(1)}
                    type="button"
                  >
                    {zoomLabel}
                  </button>
                </TooltipTrigger>
                <TooltipContent>{t("fitToScreen")}</TooltipContent>
              </Tooltip>
              <ControlButton
                label={t("zoomIn")}
                onClick={() => updateZoom(zoom * ZOOM_STEP)}
              >
                <Plus className="h-4 w-4" />
              </ControlButton>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    aria-label={t("actualSize")}
                    className="lightbox-control-button px-2 font-semibold text-[10px]"
                    onClick={showActualPixels}
                    type="button"
                  >
                    1:1
                  </button>
                </TooltipTrigger>
                <TooltipContent>{t("actualSize")}</TooltipContent>
              </Tooltip>
              <div className="mx-1 h-5 border-white/10 border-l" />
              <ControlButton
                label={t("rotateLeft")}
                onClick={() => {
                  setRotation((value) => value - 90);
                  setPlaying(false);
                }}
              >
                <RotateCcw className="h-4 w-4" />
              </ControlButton>
              <ControlButton
                label={t("rotateRight")}
                onClick={() => {
                  setRotation((value) => value + 90);
                  setPlaying(false);
                }}
              >
                <RotateCw className="h-4 w-4" />
              </ControlButton>
              {photos.length > 1 && (
                <>
                  <div className="mx-1 h-5 border-white/10 border-l" />
                  <ControlButton
                    active={thumbnailsVisible}
                    label={t("toggleThumbnails")}
                    onClick={toggleThumbnails}
                  >
                    <Rows3 className="h-4 w-4" />
                  </ControlButton>
                </>
              )}
            </div>
          )}
        </div>

        {thumbnailsVisible && (
          <div className="absolute inset-x-0 bottom-0 z-20 h-24 border-white/10 border-t bg-black/80 px-3 py-2 backdrop-blur-xl">
            <div
              className="flex h-full gap-2 overflow-x-auto overscroll-contain"
              onWheel={(event) => {
                if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
                  event.currentTarget.scrollLeft += event.deltaY;
                }
              }}
            >
              {thumbnailItems.map(({ item, index, src }) => (
                <button
                  aria-label={`${index + 1}: ${item.filename}`}
                  className={`relative h-full w-24 shrink-0 overflow-hidden rounded-md border-2 transition-all ${index === safeIndex ? "border-primary opacity-100" : "border-transparent opacity-45 hover:opacity-80"}`}
                  key={item.id}
                  onClick={() => {
                    setPhotoIndex(index);
                    resetView();
                    setLoaded(false);
                    setImageError(false);
                    setPlaying(false);
                  }}
                  ref={(node) => {
                    if (node) {
                      thumbnailRefs.current.set(item.id, node);
                    } else {
                      thumbnailRefs.current.delete(item.id);
                    }
                  }}
                  type="button"
                >
                  <img
                    alt=""
                    className="h-full w-full object-cover"
                    draggable={false}
                    height={item.height || undefined}
                    src={src}
                    width={item.width || undefined}
                  />
                  {index === safeIndex && (
                    <span className="absolute right-1 bottom-1 rounded bg-primary px-1 text-[9px] text-primary-foreground">
                      {index + 1}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {infoVisible && (
        <LightboxInfoPanel
          onClose={() => setInfoVisible(false)}
          onOpenExplorer={(path) => {
            ipc.client.shell.openInExplorer({ path }).catch(() => undefined);
          }}
          photo={photo}
        />
      )}

      <PreviewContextMenu
        menu={previewMenu}
        onClose={() => setPreviewMenu((value) => ({ ...value, open: false }))}
        onOpenExplorer={(path) => {
          ipc.client.shell.openInExplorer({ path }).catch(() => undefined);
        }}
      />
    </div>,
    document.body
  );
});

function ControlButton({
  active = false,
  disabled = false,
  label,
  onClick,
  children,
}: {
  active?: boolean;
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
          aria-pressed={active || undefined}
          className={`lightbox-control-button ${active ? "bg-white/15 text-white" : ""}`}
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

function MenuButton({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[12px] text-white/70 transition-colors hover:bg-white/10 hover:text-white"
      onClick={onClick}
      type="button"
    >
      {icon}
      {label}
    </button>
  );
}
