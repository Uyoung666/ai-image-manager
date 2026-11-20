import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Info,
  Minus,
  MoreHorizontal,
  Plus,
  Rows3,
  X,
  ZoomIn as ZoomIcon,
} from "lucide-react";
import {
  type DragEvent,
  memo,
  type PointerEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  type LightboxPanelMode,
  readLightboxPanelMode,
  saveLightboxPanelMode,
} from "@/actions/lightbox-panel-preferences";
import { wanderActions } from "@/actions/wander";
import { GalleryLightboxThumbnail } from "@/components/GalleryLightboxThumbnail";
import { Copy } from "@/components/icons/copy";
import { FavoriteIcon as Star } from "@/components/icons/favorite-icon";
import { FolderOpen } from "@/components/icons/folder-open";
import { IconMotionTrigger } from "@/components/icons/icon-motion";
import { Image as ImageIcon } from "@/components/icons/image";
import { Maximize } from "@/components/icons/maximize";
import { Minimize } from "@/components/icons/minimize";
import { Pause } from "@/components/icons/pause";
import { Play } from "@/components/icons/play";
import { RotateCcw } from "@/components/icons/rotate-ccw";
import { RotateCw } from "@/components/icons/rotate-cw";
import {
  isLibrarySourceUnavailable,
  LibraryPhotoStatusBadge,
} from "@/components/LibraryPhotoStatus";
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
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipPortalProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useBrowseArea,
  useBrowsePlaceholder,
  useBrowsePrefetch,
  useBrowseTiming,
} from "@/hooks/use-browse-image";
import { useLightboxImage } from "@/hooks/use-lightbox-image";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { useHorizontalGalleryWindow } from "@/hooks/useHorizontalGalleryWindow";
import { ipc } from "@/ipc/manager";
import type { LibraryPhotoStatus } from "@/types/library-reliability";
import { browseMedia, browsePhotoKey, fitImage } from "@/utils/browse-image";
import {
  ensureGalleryPhotos,
  getGalleryDataVersion,
  subscribeGalleryData,
} from "@/utils/gallery-data-source";
import { limitLightboxPan, rotatedPoint } from "@/utils/lightbox-zoom";
import {
  preloadImage,
  toGalleryThumbnailUrl,
  toLocalMediaUrl,
} from "@/utils/local-media-url";

export interface LightboxPhoto extends LightboxInfoPhoto, LibraryPhotoStatus {
  isFavorite?: boolean | null;
  thumbnailPath?: string | null;
  thumbnailVersion?: string;
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
const CONTROL_REVEAL_EDGE = 24;
const CONTROL_HIDE_DELAY = 3000;
const LIGHTBOX_POPOVER_CLASS_NAME =
  "z-[1100] max-h-[min(20rem,var(--radix-popover-content-available-height))] w-56 max-w-[calc(100dvw-1rem)] gap-0 overflow-y-auto overscroll-contain rounded-lg border border-white/10 bg-[#1a1a1e]/95 p-1.5 text-white shadow-2xl backdrop-blur-xl";

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function isEditableTarget(target: EventTarget | null) {
  return (
    (target instanceof HTMLInputElement && target.type !== "checkbox") ||
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

function getInitialPanelMode({
  autoPlay,
  sequencePlayback,
  showThumbnailsInitially,
}: {
  autoPlay: boolean;
  sequencePlayback: boolean;
  showThumbnailsInitially: boolean;
}): LightboxPanelMode {
  if (showThumbnailsInitially) {
    return "thumbnails";
  }
  if (sequencePlayback || autoPlay) {
    return "off";
  }
  return readLightboxPanelMode();
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
  useSyncExternalStore(subscribeGalleryData, getGalleryDataVersion);
  const { t } = useTranslation();
  const navigateToSettings = useNavigate();
  const returnIndex = useLocation({
    select: (location) => location.state.__TSR_index,
  });
  const reduceMotion = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const zoomPanelRef = useRef<HTMLDivElement>(null);
  const playbackRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const { area, dpr } = useBrowseArea(canvasRef, open);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wheelFrameRef = useRef<number | null>(null);
  const wheelStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wheelZoomRef = useRef(1);
  const wheelActiveRef = useRef(false);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const keyboardFocusRef = useRef(false);
  const focusFrameRef = useRef<number | null>(null);
  const currentPhotoIdRef = useRef<number | null>(null);
  const thumbnailScrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    translateX: number;
    translateY: number;
  } | null>(null);

  const [photoIndex, setPhotoIndex] = useState(initialIndex);
  const [zoom, setZoom] = useState(1);
  const [actualPixels, setActualPixels] = useState(false);
  const [lockView, setLockView] = useState(false);
  const lockedView = useRef<{
    center: { x: number; y: number };
    photoKey: string;
    scale: number;
  } | null>(null);
  const [wheelActive, setWheelActive] = useState(false);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0);
  const [sourceKey, setSourceKey] = useState(0);
  const [previewRetry, setPreviewRetry] = useState(0);
  const [repairKey, setRepairKey] = useState("");
  const [controlsVisible, setControlsVisible] = useState(true);
  const [infoVisible, setInfoVisible] = useState(false);
  const [thumbnailsVisible, setThumbnailsVisible] = useState(false);
  const {
    items: thumbnailItems,
    totalSize: thumbnailTotalWidth,
    scrollToIndex: scrollThumbnailToIndex,
  } = useHorizontalGalleryWindow(
    photos.length,
    open && thumbnailsVisible,
    thumbnailScrollRef
  );

  const [moreOpen, setMoreOpen] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [slideshowMode, setSlideshowMode] = useState(autoPlay);
  const [playing, setPlaying] = useState(autoPlay);
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
  const sourceUnavailable = isLibrarySourceUnavailable(photo?.sourceStatus);
  useEffect(() => {
    if (open) {
      ensureGalleryPhotos(
        photos.slice(Math.max(0, safeIndex - 1), safeIndex + 2)
      ).catch(() => undefined);
    }
  }, [open, photos, safeIndex]);
  const previewPlayback = sequencePlayback && slideshowMode && playing;
  const legacyPreviewUrl = photo?.thumbnailPath
    ? toLocalMediaUrl(photo.thumbnailPath)
    : null;
  const photoKey = photo ? browsePhotoKey(photo) : "";
  const isQuarterTurn = Math.abs(rotation % 180) === 90;
  const imageArea = isQuarterTurn
    ? { width: area.height, height: area.width }
    : area;
  const fitted = photo ? fitImage(photo, imageArea) : imageArea;
  const pixelScale =
    photo && photo.width > 0 && fitted.width > 0
      ? (fitted.width * dpr) / photo.width
      : 0;
  useLayoutEffect(() => {
    if (!sequencePlayback && actualPixels && pixelScale > 0) {
      const scale = 1 / pixelScale;
      wheelZoomRef.current = scale;
      setZoom(scale);
    }
  }, [actualPixels, pixelScale, sequencePlayback]);
  const media =
    photo && browseMedia(photo, imageArea, dpr, repairKey === photoKey);
  const fit = useLightboxImage({
    enabled: open && !sequencePlayback && area.width > 0 && area.height > 0,
    photoId: photo?.id,
    retry: sourceKey,
    src: media?.fit ?? null,
  });
  const placeholder = useBrowsePlaceholder(
    sequencePlayback || sourceUnavailable ? undefined : photo,
    media?.fit ?? null,
    fit.loaded,
    media?.fit
  );
  const decodedFitEdge = fit.loaded
    ? Math.max(
        fit.ref.current?.naturalWidth ?? 0,
        fit.ref.current?.naturalHeight ?? 0
      )
    : 0;
  const wantsDetail = Boolean(
    media &&
      (((zoom > 1 || actualPixels) &&
        Math.max(fitted.width, fitted.height) * dpr * zoom >
          (decodedFitEdge || media.edge) + 1) ||
        (fit.error && !placeholder))
  );
  const needsOriginal = wantsDetail && media?.original !== media?.fit;
  const originalUrl =
    sequencePlayback && sourceUnavailable && photo
      ? toGalleryThumbnailUrl(photo.id, 1024, "offline", undefined, true) ||
        legacyPreviewUrl
      : media?.original || null;
  const original = useLightboxImage({
    enabled:
      open &&
      (sequencePlayback
        ? !(previewPlayback && legacyPreviewUrl)
        : needsOriginal),
    photoId: photo?.id,
    retry: sourceKey,
    src: originalUrl,
  });
  const previewUrl = sequencePlayback ? legacyPreviewUrl : placeholder;
  const showPreview = Boolean(previewUrl) && !original.loaded && !fit.loaded;
  const preview = useLightboxImage({
    enabled: open && showPreview,
    photoId: photo?.id,
    retry: previewRetry,
    src: previewUrl,
  });
  const imageError = sequencePlayback
    ? (original.error && !preview.loaded) ||
      (previewPlayback && preview.error) ||
      (sourceUnavailable && !original.request.src && !previewUrl)
    : fit.error &&
      (!(original.request.enabled && original.request.src) || original.error) &&
      (!preview.request.src || preview.error);
  const needsLoading =
    open &&
    Boolean(photo) &&
    !(original.loaded || fit.loaded || preview.loaded || imageError);
  const sequenceFrame = previewPlayback && previewUrl ? preview : original;
  const activeImageRequest = (sequencePlayback ? sequenceFrame : fit).request;
  useBrowsePrefetch(
    photos,
    safeIndex,
    imageArea,
    dpr,
    open && !sequencePlayback,
    true,
    fit.loaded || original.loaded
  );
  useBrowseTiming(
    photoKey,
    open && !needsLoading && !imageError && Boolean(photo),
    fit.loaded || original.loaded
  );
  const [spinnerRequest, setSpinnerRequest] = useState<
    typeof activeImageRequest | null
  >(null);
  currentPhotoIdRef.current = photo?.id ?? null;
  const favorite = photo
    ? (favoriteOverrides[photo.id] ?? Boolean(photo.isFavorite))
    : false;

  useEffect(() => {
    if (!needsLoading) {
      return;
    }
    const timeout = window.setTimeout(
      () => setSpinnerRequest(activeImageRequest),
      200
    );
    return () => window.clearTimeout(timeout);
  }, [activeImageRequest, needsLoading]);

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
    lockedView.current = null;
    setActualPixels(false);
    wheelZoomRef.current = 1;
    setZoom(1);
    setTranslate({ x: 0, y: 0 });
    setRotation(0);
  }, []);

  const changePhotoView = useCallback(() => {
    setRepairKey("");
    if (
      !(
        lockView &&
        pixelScale > 0 &&
        (actualPixels || wheelZoomRef.current !== 1)
      )
    ) {
      resetView();
      return;
    }
    const local = rotatedPoint(translate, -rotation);
    const scale = wheelZoomRef.current;
    lockedView.current = {
      center: {
        x: local.x / (fitted.width * scale),
        y: local.y / (fitted.height * scale),
      },
      scale: scale * pixelScale,
      photoKey,
    };
    setRotation(0);
  }, [
    actualPixels,
    fitted.height,
    fitted.width,
    lockView,
    photoKey,
    pixelScale,
    resetView,
    rotation,
    translate,
  ]);

  useLayoutEffect(() => {
    if (
      !(
        open &&
        lockView &&
        lockedView.current &&
        lockedView.current.photoKey !== photoKey &&
        pixelScale > 0
      )
    ) {
      return;
    }
    const { center, scale } = lockedView.current;
    lockedView.current = null;
    const next = clamp(
      scale / pixelScale,
      Number.EPSILON,
      Math.max(MAX_ZOOM, 1 / pixelScale)
    );
    wheelZoomRef.current = next;
    setZoom(next);
    setTranslate(
      limitLightboxPan(
        {
          x: center.x * fitted.width * next,
          y: center.y * fitted.height * next,
        },
        fitted,
        area,
        next
      )
    );
  }, [area, fitted, lockView, open, photoKey, pixelScale]);

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
      changePhotoView();
      setMoreOpen(false);
      if (manual) {
        setPlaying(false);
      }
    },
    [changePhotoView, photos.length, reduceMotion]
  );

  const updateZoom = useCallback(
    (next: number, manual = true) => {
      const value = clamp(
        next,
        1,
        Math.max(MAX_ZOOM, pixelScale ? 1 / pixelScale : MAX_ZOOM)
      );
      setActualPixels(false);
      wheelZoomRef.current = value;
      setZoom(value);
      if (value <= 1.001) {
        setTranslate({ x: 0, y: 0 });
      }
      if (manual) {
        setPlaying(false);
      }
    },
    [pixelScale]
  );

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
        Math.max(MAX_ZOOM, pixelScale ? 1 / pixelScale : MAX_ZOOM)
      );
      setActualPixels(false);
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
    [pixelScale]
  );

  const showActualPixels = useCallback(() => {
    setPlaying(false);
    if (!sequencePlayback && pixelScale) {
      const scale = 1 / pixelScale;
      setActualPixels(true);
      wheelZoomRef.current = scale;
      setZoom(scale);
      setTranslate((point) =>
        limitLightboxPan(point, fitted, area, scale, isQuarterTurn)
      );
      return;
    }
    const image = original.loaded
      ? original.ref.current
      : (preview.ref.current ?? original.ref.current);
    if (!image?.clientWidth) {
      return;
    }
    const width = original.loaded
      ? image.naturalWidth || photo?.width
      : photo?.width;
    if (width) {
      updateZoom(clamp(width / image.clientWidth, 1, MAX_ZOOM));
    }
  }, [
    area,
    fitted,
    isQuarterTurn,
    original.loaded,
    original.ref,
    photo?.width,
    pixelScale,
    preview.ref,
    sequencePlayback,
    updateZoom,
  ]);

  const toggleInfo = useCallback(() => {
    const nextVisible = !infoVisible;
    setInfoVisible(nextVisible);
    if (nextVisible) {
      setThumbnailsVisible(false);
    }
    if (!(sequencePlayback || autoPlay)) {
      saveLightboxPanelMode(nextVisible ? "info" : "off");
    }
    setPlaying(false);
    setMoreOpen(false);
  }, [autoPlay, infoVisible, sequencePlayback]);

  const closeInfoPanel = useCallback(() => {
    setInfoVisible(false);
    if (!(sequencePlayback || autoPlay)) {
      saveLightboxPanelMode("off");
    }
  }, [autoPlay, sequencePlayback]);

  const toggleThumbnails = useCallback(() => {
    if (photos.length <= 1) {
      return;
    }
    const nextVisible = !thumbnailsVisible;
    setThumbnailsVisible(nextVisible);
    if (nextVisible) {
      setInfoVisible(false);
    }
    if (!(sequencePlayback || autoPlay)) {
      saveLightboxPanelMode(nextVisible ? "thumbnails" : "off");
    }
    setMoreOpen(false);
  }, [autoPlay, photos.length, sequencePlayback, thumbnailsVisible]);

  const closeThumbnails = useCallback(() => {
    setThumbnailsVisible(false);
    if (!(sequencePlayback || autoPlay)) {
      saveLightboxPanelMode("off");
    }
  }, [autoPlay, sequencePlayback]);

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
    setZoomOpen(false);
  }, []);

  const stopSlideshow = useCallback(() => {
    setPlaying(false);
    setSlideshowMode(false);
    setProgress(0);
  }, []);

  const rotateImage = useCallback((degrees: number) => {
    setRotation((value) => value + degrees);
    setPlaying(false);
    setMoreOpen(false);
  }, []);

  const scheduleControlsHide = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
    }
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null;
      const focused = document.activeElement;
      if (
        (keyboardFocusRef.current &&
          focused?.matches(":focus-visible") &&
          focused.closest("[data-lightbox-controls]")) ||
        headerRef.current?.matches(":hover") ||
        playbackRef.current?.matches(":hover")
      ) {
        return;
      }
      setControlsVisible(false);
    }, CONTROL_HIDE_DELAY);
  }, []);

  const revealControls = useCallback(() => {
    setControlsVisible(true);
    scheduleControlsHide();
  }, [scheduleControlsHide]);

  useEffect(() => {
    if (!open) {
      setLockView(false);
      return;
    }
    keyboardFocusRef.current = false;
    setPhotoIndex(initialIndex);
    setRepairKey("");
    resetView();
    setControlsVisible(true);
    const initialPanelMode = getInitialPanelMode({
      autoPlay,
      sequencePlayback,
      showThumbnailsInitially,
    });
    setInfoVisible(initialPanelMode === "info");
    setThumbnailsVisible(initialPanelMode === "thumbnails");
    setMoreOpen(false);
    setZoomOpen(false);
    setSlideshowMode(autoPlay);
    setPlaying(autoPlay);
    setProgress(0);
    setFavoriteOverrides({});
  }, [
    autoPlay,
    initialIndex,
    open,
    resetView,
    sequencePlayback,
    showThumbnailsInitially,
  ]);

  useEffect(() => {
    if (!open || photos.length <= 1) {
      setThumbnailsVisible(false);
    }
  }, [open, photos.length]);

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
    if (!(open && photo && sequencePlayback)) {
      return;
    }
    const ahead = previewPlayback ? 12 : 2;
    const behind = previewPlayback ? 1 : 2;
    const preloadedIndices = new Set<number>();
    const releases: Array<() => void> = [];
    for (let offset = -behind; offset <= ahead; offset += 1) {
      const index = (safeIndex + offset + photos.length) % photos.length;
      if (index === safeIndex || preloadedIndices.has(index)) {
        continue;
      }
      preloadedIndices.add(index);
      const release = preloadImage(
        photos[index].thumbnailPath ?? photos[index].path
      );
      if (typeof release === "function") {
        releases.push(release);
      }
    }
    return () => {
      for (const release of releases) {
        release();
      }
    };
  }, [open, photo, photos, previewPlayback, safeIndex, sequencePlayback]);

  useEffect(() => {
    if (!(open && thumbnailsVisible && photo)) {
      return;
    }
    scrollThumbnailToIndex(safeIndex, {
      align: "center",
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, [
    open,
    photo,
    reduceMotion,
    thumbnailsVisible,
    safeIndex,
    scrollThumbnailToIndex,
  ]);

  useEffect(() => {
    if (!open) {
      return;
    }
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const focusRoot = rootRef.current;
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
      const active = document.activeElement;
      if (
        previousFocus?.isConnected &&
        (!active || active === document.body || focusRoot?.contains(active))
      ) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [open]);

  useEffect(() => {
    const handler = () => {
      const fullscreen =
        !!rootRef.current && document.fullscreenElement === rootRef.current;
      setIsFullscreen(fullscreen);
      if (fullscreen) {
        rootRef.current?.focus({ preventScroll: true });
        setControlsVisible(false);
      } else {
        revealControls();
      }
    };
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, [revealControls]);

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
      if (
        isEditableTarget(event.target) ||
        (event.key === " " &&
          ((event.target instanceof HTMLInputElement &&
            event.target.type === "checkbox") ||
            (keyboardFocusRef.current &&
              event.target instanceof HTMLButtonElement)))
      ) {
        return;
      }
      if (event.key === "Tab") {
        keyboardFocusRef.current = true;
        const root = zoomPanelRef.current ?? rootRef.current;
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
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (previewMenu.open) {
          setPreviewMenu((value) => ({ ...value, open: false }));
        } else if (zoomOpen || moreOpen) {
          setZoomOpen(false);
          setMoreOpen(false);
        } else if (infoVisible) {
          closeInfoPanel();
        } else if (thumbnailsVisible) {
          closeThumbnails();
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
        rotateImage(event.shiftKey ? -90 : 90);
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
      if (!isFullscreen) {
        revealControls();
      }
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [
    closeInfoPanel,
    closeThumbnails,
    infoVisible,
    isFullscreen,
    moreOpen,
    modalOpen,
    navigate,
    open,
    previewMenu.open,
    requestClose,
    revealControls,
    rotateImage,
    showActualPixels,
    slideshowMode,
    startSlideshow,
    thumbnailsVisible,
    toggleFavorite,
    toggleInfo,
    toggleThumbnails,
    updateZoom,
    zoom,
    zoomOpen,
  ]);

  const chromeVisible = controlsVisible || moreOpen || zoomOpen || modalOpen;
  const chromeClass = chromeVisible
    ? "pointer-events-auto opacity-100"
    : "pointer-events-none opacity-0";
  const viewerChromeClass = isFullscreen ? chromeClass : "";
  const playbackChromeClass = playing ? chromeClass : "";
  const fitMode = sequencePlayback ? zoom <= 1.05 : zoom === 1 && !actualPixels;
  const zoomLabel =
    !sequencePlayback && fitMode
      ? t("lightboxFitLabel")
      : `${Math.round(zoom * (sequencePlayback ? 1 : pixelScale || 1) * 100)}%`;
  const firstThumbnail = thumbnailItems[0]?.index ?? 0;
  const lastThumbnail = thumbnailItems.at(-1)?.index ?? 0;
  useEffect(() => {
    if (open && thumbnailsVisible) {
      ensureGalleryPhotos(
        photos.slice(firstThumbnail, lastThumbnail + 1)
      ).catch(() => undefined);
    }
  }, [open, thumbnailsVisible, photos, firstThumbnail, lastThumbnail]);

  if (!(open && photo && photos.length)) {
    return null;
  }

  const imageStyle = {
    gridArea: "1 / 1",
    width: !sequencePlayback && fitted.width ? fitted.width : undefined,
    height: !sequencePlayback && fitted.height ? fitted.height : undefined,
    maxHeight: isQuarterTurn && imageArea.height ? imageArea.height : undefined,
    maxWidth: isQuarterTurn && imageArea.width ? imageArea.width : undefined,
    transform: `translate3d(${translate.x}px, ${translate.y}px, 0) scale(${zoom}) rotate(${rotation}deg)`,
    backfaceVisibility: "hidden" as const,
    transition:
      reduceMotion || dragRef.current || wheelActive
        ? "none"
        : "transform 150ms cubic-bezier(0.16, 1, 0.3, 1)",
    willChange: "transform",
  };
  const frames = [
    ...(showPreview && previewUrl
      ? [
          {
            kind: "preview",
            src: previewUrl,
            state: preview,
            retry: previewRetry,
          },
        ]
      : []),
    ...(original.request.enabled && original.request.src
      ? [
          {
            kind: "original",
            src: original.request.src,
            state: original,
            retry: sourceKey,
          },
        ]
      : []),
    ...(fit.request.enabled && fit.request.src
      ? [{ kind: "fit", src: fit.request.src, state: fit, retry: sourceKey }]
      : []),
  ];
  const retryImage = () => {
    if (preview.error) {
      setPreviewRetry((value) => value + 1);
    }
    if (fit.error) {
      setRepairKey(photoKey);
    }
    setSourceKey((value) => value + 1);
  };
  const originalFailedWithPreview =
    (original.error && (preview.loaded || fit.loaded)) ||
    (fit.error && preview.loaded && !original.loaded);
  const initialFrame = sequencePlayback ? sequenceFrame : fit;
  const visibleFrame =
    [original, fit, preview].find((frame) => frame.loaded) ?? initialFrame;
  const originalFrame = original.request.enabled ? original : fit;
  const panClass = zoom > 1 ? "cursor-grab active:cursor-grabbing" : "";
  const beginPan = (event: PointerEvent<HTMLImageElement>) => {
    if (zoom <= 1) {
      return;
    }
    canvasRef.current?.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      translateX: translate.x,
      translateY: translate.y,
    };
  };
  const startOriginalDrag = (event: DragEvent<HTMLImageElement>) => {
    event.preventDefault();
    if (!sourceUnavailable && zoom <= 1) {
      window.electronAPI?.startDrag?.(photo.path);
    }
  };
  const toggleZoom = () => {
    if (fitMode) {
      showActualPixels();
    } else {
      updateZoom(1);
    }
  };

  const content = createPortal(
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: the modal dialog surface owns global reveal and image context-menu interactions.
    <div
      aria-label={t("lightboxReview")}
      aria-modal="true"
      className={`lightbox-interactive fixed inset-0 z-[1000] flex overflow-hidden bg-[#09090b] text-white outline-none ${isFullscreen && !chromeVisible ? "cursor-none" : "cursor-default"}`}
      onBlur={scheduleControlsHide}
      onContextMenu={(event) => {
        const target = event.target as HTMLElement;
        if (!target.closest("[data-lightbox-image]")) {
          return;
        }
        event.preventDefault();
        setPreviewMenu({
          open: true,
          photoPath: photo.path,
          sourceUnavailable: isLibrarySourceUnavailable(photo.sourceStatus),
          x: event.clientX,
          y: event.clientY,
        });
      }}
      onFocusCapture={(event) => {
        if (event.target.closest("[data-lightbox-controls]")) {
          revealControls();
        }
      }}
      onMouseMove={(event) => {
        if (
          !isFullscreen ||
          event.clientY < CONTROL_REVEAL_EDGE ||
          (slideshowMode &&
            event.clientY >= window.innerHeight - CONTROL_REVEAL_EDGE)
        ) {
          revealControls();
        }
      }}
      onMouseOut={(event) => {
        const region = (event.target as Element).closest(
          "[data-lightbox-controls]"
        );
        const nextTarget =
          event.relatedTarget instanceof Node ? event.relatedTarget : null;
        if (region && !region.contains(nextTarget)) {
          scheduleControlsHide();
        }
      }}
      onPointerDownCapture={() => {
        keyboardFocusRef.current = false;
      }}
      ref={rootRef}
      role="dialog"
      tabIndex={-1}
    >
      <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto_auto] overflow-hidden">
        <header
          className={`col-start-1 row-start-1 flex h-14 min-w-0 cursor-default select-none items-center justify-between gap-3 border-white/10 border-b bg-black/45 px-2 transition-opacity duration-200 motion-reduce:transition-none max-[540px]:h-auto max-[540px]:min-h-14 max-[540px]:flex-col max-[540px]:items-stretch max-[540px]:gap-1 max-[540px]:py-1 sm:gap-5 sm:px-4 ${viewerChromeClass}`}
          data-lightbox-controls
          data-lightbox-window-drag={!isFullscreen || undefined}
          ref={headerRef}
        >
          <div className="flex min-w-0 items-center gap-3">
            <span
              className={`shrink-0 rounded-full bg-white/10 px-2.5 py-1 text-[11px] text-white/70 transition-transform ${wrapPulse ? "scale-110" : "scale-100"}`}
            >
              {safeIndex + 1} / {photos.length}
            </span>
            <div className="flex min-w-0 flex-col">
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
              {originalFailedWithPreview && (
                <div
                  className="flex min-w-0 items-center gap-2 text-[11px] text-white/75"
                  role="status"
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className="min-w-0 truncate"
                        // biome-ignore lint/a11y/noNoninteractiveTabindex: truncated failure detail must expose its Tooltip to keyboard users
                        tabIndex={0}
                      >
                        {t("imageOriginalLoadFailed")}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {t("imageOriginalLoadFailed")}
                    </TooltipContent>
                  </Tooltip>
                  <button
                    className="shrink-0 rounded px-1.5 py-0.5 text-white/85 hover:bg-white/10"
                    onClick={retryImage}
                    type="button"
                  >
                    {t("retry")}
                  </button>
                </div>
              )}
              {!sequencePlayback &&
                (sourceUnavailable ||
                  (original.request.enabled &&
                    original.request.src &&
                    !original.loaded &&
                    !originalFailedWithPreview)) &&
                (fit.loaded || preview.loaded) && (
                  <span className="text-[11px] text-white/75" role="status">
                    {t("lightboxLimitedDetail")}
                  </span>
                )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1 max-[540px]:justify-end max-[540px]:gap-0">
            <Popover onOpenChange={setZoomOpen} open={zoomOpen}>
              <Tooltip disabled={zoomOpen}>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <button
                      aria-label={`${t("lightboxZoom")} · ${zoomLabel}`}
                      className="lightbox-control-button gap-1.5 px-2 text-xs tabular-nums data-[state=open]:bg-white/15"
                      type="button"
                    >
                      <ZoomIcon className="size-4" />
                      <span className="max-w-28 truncate max-[440px]:sr-only">
                        {zoomLabel}
                      </span>
                      <ChevronDown className="hidden size-3 sm:block" />
                    </button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {t("lightboxZoom")} · {zoomLabel}
                </TooltipContent>
              </Tooltip>
              {zoomOpen && (
                <PopoverContent
                  align="end"
                  aria-label={t("lightboxZoom")}
                  className={LIGHTBOX_POPOVER_CLASS_NAME}
                  collisionPadding={8}
                  data-lightbox-controls
                  onOpenAutoFocus={(event) => {
                    event.preventDefault();
                    zoomPanelRef.current?.focus({ preventScroll: true });
                  }}
                  portalContainer={rootRef.current}
                  ref={zoomPanelRef}
                  sideOffset={6}
                >
                  <div className="flex min-w-0 items-center justify-between gap-1 px-1">
                    <ControlButton
                      label={t("zoomOut")}
                      onClick={() => updateZoom(zoom / ZOOM_STEP)}
                    >
                      <Minus className="size-4" />
                    </ControlButton>
                    <span className="min-w-0 text-center text-white/70 tabular-nums">
                      {zoomLabel}
                    </span>
                    <ControlButton
                      label={t("zoomIn")}
                      onClick={() => updateZoom(zoom * ZOOM_STEP)}
                    >
                      <Plus className="size-4" />
                    </ControlButton>
                  </div>
                  <div className="my-1 border-white/10 border-t" />
                  <MenuButton
                    icon={<Maximize className="size-4 shrink-0" />}
                    label={t("fitToScreen")}
                    onClick={() => {
                      updateZoom(1);
                      setZoomOpen(false);
                    }}
                  />
                  <MenuButton
                    icon={
                      <span
                        aria-hidden="true"
                        className="w-4 shrink-0 text-[10px]"
                      >
                        1:1
                      </span>
                    }
                    label={t("actualSize")}
                    onClick={() => {
                      showActualPixels();
                      setZoomOpen(false);
                    }}
                  />
                  {!sequencePlayback && (
                    <>
                      <div className="my-1 border-white/10 border-t" />
                      <div className="flex min-w-0 items-center justify-between gap-2 px-2.5 py-1.5 text-white/70">
                        <span className="wrap-anywhere min-w-0">
                          {t("lightboxLockView")}
                        </span>
                        <span className="inline-flex shrink-0">
                          <Switch
                            ariaLabel={t("lightboxLockView")}
                            checked={lockView}
                            onCheckedChange={setLockView}
                          />
                        </span>
                      </div>
                    </>
                  )}
                </PopoverContent>
              )}
            </Popover>
            <ControlButton
              label={t("rotateLeft")}
              onClick={() => rotateImage(-90)}
            >
              <RotateCcw className="size-4" />
            </ControlButton>
            <ControlButton
              label={t("rotateRight")}
              onClick={() => rotateImage(90)}
            >
              <RotateCw className="size-4" />
            </ControlButton>
            {photos.length > 1 && (
              <ControlButton
                active={thumbnailsVisible}
                label={t("toggleThumbnails")}
                onClick={toggleThumbnails}
              >
                <Rows3 className="size-4" />
              </ControlButton>
            )}
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
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <button
                      aria-label={t("more")}
                      className="lightbox-control-button data-[state=open]:bg-white/15"
                      type="button"
                    >
                      <MoreHorizontal className="size-4" />
                    </button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t("more")}</TooltipContent>
              </Tooltip>
              {moreOpen && (
                <PopoverContent
                  align="end"
                  aria-label={t("more")}
                  className={LIGHTBOX_POPOVER_CLASS_NAME}
                  collisionPadding={8}
                  data-lightbox-controls
                  portalContainer={rootRef.current}
                  sideOffset={6}
                >
                  {onAddToAlbum && (
                    <MenuButton
                      icon={<Rows3 className="h-4 w-4" />}
                      label={t("addToAlbum")}
                      onClick={async () => {
                        setMoreOpen(false);
                        if (isFullscreen) {
                          try {
                            await document.exitFullscreen();
                          } catch {
                            toast.error(t("fullscreenFailed"));
                            return;
                          }
                        }
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
                      try {
                        const ok =
                          await window.electronAPI?.copyImageToClipboard?.(
                            photo.path
                          );
                        if (ok) {
                          toast.success(t("imageCopiedToClipboard"));
                        } else {
                          toast.error(t("copyFailed"));
                        }
                      } catch {
                        toast.error(t("copyFailed"));
                      }
                      setMoreOpen(false);
                    }}
                  />
                  <MenuButton
                    icon={<Copy className="h-4 w-4" />}
                    label={t("copyPath")}
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(photo.path);
                        toast.success(t("pathCopied"));
                      } catch {
                        toast.error(t("copyFailed"));
                      }
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
          className="relative col-start-1 row-start-2 grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] place-items-center overflow-hidden px-10 py-2 sm:px-16"
          data-lightbox-canvas
          onLostPointerCapture={() => {
            dragRef.current = null;
          }}
          onPointerCancel={() => {
            dragRef.current = null;
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== event.pointerId) {
              return;
            }
            const point = {
              x: drag.translateX + event.clientX - drag.startX,
              y: drag.translateY + event.clientY - drag.startY,
            };
            setTranslate(
              sequencePlayback
                ? point
                : limitLightboxPan(point, fitted, area, zoom, isQuarterTurn)
            );
          }}
          onPointerUp={(event) => {
            if (dragRef.current?.pointerId === event.pointerId) {
              dragRef.current = null;
            }
          }}
          ref={canvasRef}
        >
          {imageError && (
            <div className="flex max-w-full flex-col items-center gap-3 text-center [grid-area:1/1]">
              <ImageIcon className="h-10 w-10 text-white/25" />
              <p className="text-[13px] text-white/65">
                {t(
                  sourceUnavailable
                    ? "libraryReliability.previewUnavailable"
                    : "imageLoadFailed"
                )}
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
                    if (sourceUnavailable) {
                      requestClose();
                      navigateToSettings({
                        to: "/settings/library",
                        search: { photoId: photo.id },
                        state: { libraryReturnIndex: returnIndex },
                      });
                    } else {
                      retryImage();
                    }
                  }}
                  type="button"
                >
                  {t(
                    sourceUnavailable
                      ? "libraryReliability.goToSettings"
                      : "retry"
                  )}
                </button>
                <IconMotionTrigger asChild>
                  <button
                    className="lightbox-secondary-button"
                    disabled={sourceUnavailable}
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
                </IconMotionTrigger>
              </div>
            </div>
          )}
          {sourceUnavailable && !imageError && (
            <p className="absolute bottom-2 rounded bg-popover/90 px-2 py-1 text-popover-foreground text-xs">
              {t("libraryReliability.detail.cached")}
            </p>
          )}
          {frames.map((frame) => {
            const selected = frame.state === visibleFrame;
            const visible = selected && frame.state.loaded && !imageError;
            return (
              <img
                alt={photo.filename}
                aria-hidden={
                  imageError || frame.state !== visibleFrame || undefined
                }
                className={`max-h-full max-w-full select-none object-contain ${visible ? "opacity-100" : "pointer-events-none opacity-0"} ${panClass}`}
                data-browse-frame={
                  frame.kind === "preview" ? "placeholder" : "clear"
                }
                data-browse-visible={visible || undefined}
                data-lightbox-image={
                  selected ||
                  (sequencePlayback &&
                    showPreview &&
                    frame.kind === "preview") ||
                  undefined
                }
                data-lightbox-original-frame={
                  frame.state === originalFrame || undefined
                }
                data-lightbox-playback-frame={
                  frame.kind === "preview" ? true : undefined
                }
                draggable={!(sourceUnavailable || previewPlayback) && zoom <= 1}
                height={photo.height || undefined}
                key={`${frame.kind}-${photo.id}-${frame.src}-${frame.retry}`}
                onDoubleClick={toggleZoom}
                onDragStart={startOriginalDrag}
                onPointerDown={beginPan}
                onWheel={handleWheelZoom}
                ref={frame.state.ref}
                style={imageStyle}
                width={photo.width || undefined}
              />
            );
          })}
          {needsLoading && spinnerRequest === activeImageRequest && (
            <div className="absolute inset-0 flex items-center justify-center">
              <LoadingSpinner
                aria-label={t("loading")}
                data-reduced-motion-keep="spinner"
                size="lg"
                variant="overlay"
              />
            </div>
          )}
          <LibraryPhotoStatusBadge
            refreshStatus={photo.refreshStatus}
            sourceStatus={photo.sourceStatus}
          />
        </div>

        {photos.length > 1 && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  aria-label={t("previousPhoto")}
                  className={`group z-10 col-start-1 row-start-2 flex w-10 items-center justify-center justify-self-start transition-opacity duration-200 sm:w-16 ${chromeClass}`}
                  data-lightbox-controls
                  onClick={() => navigate(-1)}
                  type="button"
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-black/35 text-white/60 opacity-40 transition-all group-hover:bg-black/70 group-hover:text-white group-hover:opacity-100">
                    <ChevronLeft className="h-6 w-6" />
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">{t("previousPhoto")}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  aria-label={t("nextPhoto")}
                  className={`group z-10 col-start-1 row-start-2 flex w-10 items-center justify-center justify-self-end transition-opacity duration-200 sm:w-16 ${chromeClass}`}
                  data-lightbox-controls
                  onClick={() => navigate(1)}
                  type="button"
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-black/35 text-white/60 opacity-40 transition-all group-hover:bg-black/70 group-hover:text-white group-hover:opacity-100">
                    <ChevronRight className="h-6 w-6" />
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="left">{t("nextPhoto")}</TooltipContent>
            </Tooltip>
          </>
        )}

        {slideshowMode && (
          <div
            className={`col-start-1 row-start-3 min-w-0 cursor-default overflow-x-auto overscroll-x-contain whitespace-nowrap border-white/10 border-t bg-black/45 px-2 py-1.5 transition-opacity duration-200 motion-reduce:transition-none sm:px-3 ${playbackChromeClass}`}
            data-lightbox-controls
            data-lightbox-playback-toolbar
            ref={playbackRef}
          >
            <div className="relative flex w-max items-center gap-1">
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
          </div>
        )}

        {thumbnailsVisible && (
          <div className="col-start-1 row-start-4 h-24 min-w-0 cursor-default border-white/10 border-t bg-black/45 px-3 py-2">
            <div
              className="flex h-full gap-2 overflow-x-auto overscroll-contain"
              data-lightbox-thumbnail-strip
              onWheel={(event) => {
                if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
                  event.currentTarget.scrollLeft += event.deltaY;
                }
              }}
              ref={thumbnailScrollRef}
            >
              <div
                style={{
                  position: "relative",
                  height: "100%",
                  width: thumbnailTotalWidth,
                  flexShrink: 0,
                }}
              >
                {thumbnailItems.map((virtualItem) => {
                  const index = virtualItem.index;
                  const item = photos[index];
                  return (
                    <button
                      aria-label={`${index + 1}: ${item.filename}`}
                      className={`relative h-full w-24 shrink-0 overflow-hidden rounded-md border-2 transition-all ${index === safeIndex ? "border-primary opacity-100" : "border-transparent opacity-45 hover:opacity-80"}`}
                      key={item.id}
                      onClick={() => {
                        setPhotoIndex(index);
                        if (index !== safeIndex) {
                          changePhotoView();
                        }
                        setPlaying(false);
                      }}
                      style={{
                        position: "absolute",
                        left: 0,
                        top: 0,
                        transform: `translateX(${virtualItem.start}px)`,
                      }}
                      type="button"
                    >
                      <GalleryLightboxThumbnail photo={item} />
                      {index === safeIndex && (
                        <span className="absolute right-1 bottom-1 rounded bg-primary px-1 text-[9px] text-primary-foreground">
                          {index + 1}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {infoVisible && (
        <LightboxInfoPanel
          onClose={closeInfoPanel}
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

  return (
    <TooltipPortalProvider containerRef={rootRef}>
      {content}
    </TooltipPortalProvider>
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
        <IconMotionTrigger asChild disabled={disabled}>
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
        </IconMotionTrigger>
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
    <IconMotionTrigger asChild>
      <button
        className="flex w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[12px] text-white/70 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-primary [&_svg]:shrink-0"
        onClick={onClick}
        type="button"
      >
        {icon}
        <span className="wrap-anywhere min-w-0">{label}</span>
      </button>
    </IconMotionTrigger>
  );
}
