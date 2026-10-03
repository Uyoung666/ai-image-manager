/** biome-ignore-all lint/style/useFilenamingConvention: component names follow the repository's existing React convention. */
import { Pause, Play, Save, SkipForward, X } from "lucide-react";
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { recordWanderExposure } from "@/actions/wander";
import { HamsterWheelLoader } from "@/components/startup-splash";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ZoomableImage } from "@/components/ZoomableImage";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useModalFocusTrap } from "@/hooks/use-modal-focus-trap";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import type {
  WanderPhoto,
  WanderSession,
  WanderSettings,
} from "@/types/wander";
import { preloadImagesWithConcurrency } from "@/utils/image-preloader";
import { preloadImageAsync, toLocalMediaUrl } from "@/utils/local-media-url";
import { WanderParallax } from "./WanderParallax";

const INTRO_MS = 1200;
const EXPOSURE_MS = 2000;
const CONTROLS_HIDE_MS = 3500;
const HINT_HIDE_MS = 3500;
const WANDER_PRELOAD_CONCURRENCY = 4;

interface WanderOverlayProps {
  flowSpeed?: WanderSettings["flowSpeed"];
  intervalMs: number;
  onClose: () => void;
  onRoundComplete: () => void;
  onSave: () => void;
  preparingNext?: boolean;
  presentation?: WanderSettings["presentation"];
  previews?: Record<number, string>;
  roundNumber: number;
  saving: boolean;
  session: WanderSession;
}

type WanderView = "intro" | "playing";

function useWanderHint(view: WanderView, initiallyVisible: boolean) {
  const [hintVisible, setHintVisible] = useState(initiallyVisible);

  useEffect(() => {
    if (view !== "playing" || !hintVisible) {
      return;
    }
    const timeout = window.setTimeout(
      () => setHintVisible(false),
      HINT_HIDE_MS
    );
    return () => window.clearTimeout(timeout);
  }, [hintVisible, view]);

  return hintVisible;
}

function useWanderKeyboard({
  onClose,
  onKeyboardBrowse,
  onTogglePause,
  view,
}: {
  onClose: () => void;
  onKeyboardBrowse: () => void;
  onTogglePause: () => void;
  view: WanderView;
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
        return;
      }
      if (event.code === "Space" && view === "playing") {
        if (
          (event.target as HTMLElement)?.closest?.("input, [role='combobox']")
        ) {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        onTogglePause();
      }
      if (event.key === "Tab" || event.key.startsWith("Arrow")) {
        onKeyboardBrowse();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose, onKeyboardBrowse, onTogglePause, view]);
}

interface WanderImageStackProps {
  className?: string;
  layer: "current" | "pending";
  onPreviewError?: () => void;
  onPreviewReady?: () => void;
  photo: WanderSession["photos"][number];
  previewUrl?: string;
}

function WanderImageStack({
  previewUrl,
  className,
  layer,
  onPreviewError,
  onPreviewReady,
  photo,
}: WanderImageStackProps) {
  const [fullReady, setFullReady] = useState(false);
  const [fullError, setFullError] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);

  const previewSrc =
    previewUrl ?? toLocalMediaUrl(photo.thumbnailPath ?? photo.path);
  const fullSrc = toLocalMediaUrl(photo.path);

  return (
    <div
      className={`absolute inset-0 ${className ?? ""}`}
      data-wander-layer={layer}
      data-wander-photo-id={photo.id}
    >
      <img
        alt=""
        aria-hidden="true"
        className={`absolute inset-0 h-full w-full object-contain ${previewError ? "opacity-0" : "opacity-100"}`}
        data-wander-preview
        data-wander-preview-ready={previewReady}
        height={photo.height || 1}
        onError={() => {
          setPreviewError(true);
          onPreviewError?.();
        }}
        onLoad={() => {
          setPreviewReady(true);
          onPreviewReady?.();
        }}
        src={previewSrc}
        width={photo.width || 1}
      />
      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: the image load event updates the display layer. */}
      <img
        alt={photo.filename}
        className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-[500ms] motion-reduce:transition-none ${fullReady && !fullError ? "opacity-100" : "opacity-0"}`}
        data-wander-full
        data-wander-full-ready={fullReady}
        height={photo.height || 1}
        onError={() => setFullError(true)}
        onLoad={() => setFullReady(true)}
        src={fullSrc}
        width={photo.width || 1}
      />
    </div>
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the full-screen overlay coordinates playback, controls, and accessibility state in one modal.
export function WanderOverlay({
  presentation = "parallax",
  flowSpeed = "normal",
  previews,
  intervalMs,
  onClose,
  onRoundComplete,
  onSave,
  preparingNext = false,
  roundNumber,
  saving,
  session,
}: WanderOverlayProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<WanderView>("intro");
  const [index, setIndex] = useState(0);
  const [pendingIndex, setPendingIndex] = useState<number | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [paused, setPaused] = useState(false);
  const [failedIds, setFailedIds] = useState<Set<number>>(() => new Set());
  const [inspectedPhoto, setInspectedPhoto] = useState<WanderPhoto | null>(
    null
  );
  const [galleryProgress, setGalleryProgress] = useState(0);
  const exposedIdsRef = useRef(new Set<number>());
  const completedRef = useRef(false);
  const inspectRef = useRef<HTMLDivElement>(null);
  const inspectionReturnFocusRef = useRef<HTMLElement | null>(null);
  const systemReduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const appReduceMotion = useReducedMotion();
  const reduceMotion = systemReduceMotion || appReduceMotion;
  const galleryPhotos = useMemo(
    () => [
      ...new Map(
        session.photos
          .filter((item) => !failedIds.has(item.id))
          .map((item) => [item.id, item])
      ).values(),
    ],
    [failedIds, session.photos]
  );
  const isParallax =
    presentation === "parallax" &&
    !reduceMotion &&
    session.mode !== "hamsterWheel" &&
    galleryPhotos.length >= 6;
  const completeRound = useCallback(() => {
    if (completedRef.current || saving || preparingNext) {
      return;
    }
    completedRef.current = true;
    onRoundComplete();
  }, [onRoundComplete, preparingNext, saving]);
  const pauseGallery = useCallback(() => setPaused(true), []);
  const failGalleryPhoto = useCallback(
    (id: number) => setFailedIds((previous) => new Set(previous).add(id)),
    []
  );
  const inspectPhoto = useCallback((item: WanderPhoto) => {
    inspectionReturnFocusRef.current = document.querySelector<HTMLElement>(
      `[data-wander-parallax] [data-photo-id='${item.id}']`
    );
    setPaused(true);
    setInspectedPhoto(item);
  }, []);
  const closeInspection = useCallback(() => {
    setInspectedPhoto(null);
    setPaused(true);
  }, []);
  const dismiss = inspectedPhoto ? closeInspection : onClose;
  const controlsHoveredRef = useRef(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const previewPreloadsRef = useRef(new Map<number, Promise<boolean>>());
  const fullPreloadsRef = useRef(new Map<number, Promise<boolean>>());
  const advanceInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const pendingPreviewReadyRef = useRef<number | null>(null);
  const playbackPaused = paused || saving || preparingNext;
  const playbackStateRef = useRef({
    index,
    paused: playbackPaused,
    pendingIndex,
    view,
  });
  const photo = galleryPhotos[index];
  const isHamsterWheel = session.mode === "hamsterWheel";
  useEffect(() => {
    if (!isHamsterWheel && galleryPhotos.length === 0) {
      completeRound();
    }
  }, [completeRound, galleryPhotos.length, isHamsterWheel]);
  const pendingPhoto =
    pendingIndex === null ? undefined : galleryPhotos[pendingIndex];
  const hintVisible = useWanderHint(view, roundNumber === 1);
  playbackStateRef.current = {
    index,
    paused: playbackPaused,
    pendingIndex,
    view,
  };
  useModalFocusTrap({
    active: !inspectedPhoto,
    containerRef: overlayRef,
    onEscape: onClose,
  });
  useModalFocusTrap({
    active: Boolean(inspectedPhoto),
    containerRef: inspectRef,
    onEscape: closeInspection,
  });
  useEffect(() => {
    if (!inspectedPhoto && inspectionReturnFocusRef.current) {
      inspectionReturnFocusRef.current.focus({ preventScroll: true });
      inspectionReturnFocusRef.current = null;
    }
  }, [inspectedPhoto]);

  const preloadWanderAsset = useCallback(
    (
      item: WanderSession["photos"][number],
      kind: "preview" | "full"
    ): Promise<boolean> => {
      const filePath =
        kind === "preview" ? (item.thumbnailPath ?? item.path) : item.path;
      const cache =
        kind === "preview"
          ? previewPreloadsRef.current
          : fullPreloadsRef.current;
      const existing = cache.get(item.id);
      if (existing) {
        return existing;
      }

      const previewUrl = kind === "preview" ? previews?.[item.id] : undefined;
      const request = previewUrl
        ? preloadImagesWithConcurrency([previewUrl], WANDER_PRELOAD_CONCURRENCY)
            .then((result) => result.loaded > 0)
            .catch(() => false)
        : preloadImageAsync(filePath, WANDER_PRELOAD_CONCURRENCY).catch(
            () => false
          );
      cache.set(item.id, request);
      return request;
    },
    [previews]
  );

  const findNextReadyPhoto = useCallback(
    async (fromIndex: number): Promise<number | null> => {
      for (
        let nextIndex = fromIndex + 1;
        nextIndex < galleryPhotos.length;
        nextIndex++
      ) {
        const previewLoaded = await preloadWanderAsset(
          galleryPhotos[nextIndex],
          "preview"
        );
        if (previewLoaded && !failedIds.has(galleryPhotos[nextIndex].id)) {
          return nextIndex;
        }
      }
      return null;
    },
    [failedIds, preloadWanderAsset, galleryPhotos]
  );

  const requestNextTransition = useCallback(
    async (fromIndex: number, replacePending = false) => {
      if (
        advanceInFlightRef.current ||
        (!replacePending && playbackStateRef.current.pendingIndex !== null)
      ) {
        return;
      }
      advanceInFlightRef.current = true;
      try {
        const nextIndex = await findNextReadyPhoto(fromIndex);
        if (!mountedRef.current) {
          return;
        }
        const currentState = playbackStateRef.current;
        if (
          currentState.index !== fromIndex ||
          currentState.view !== "playing" ||
          currentState.paused
        ) {
          return;
        }
        if (nextIndex === null) {
          completeRound();
          return;
        }
        setPendingIndex(nextIndex);
      } finally {
        advanceInFlightRef.current = false;
      }
    },
    [completeRound, findNextReadyPhoto]
  );

  const startTransition = useCallback(
    (fromIndex: number, nextIndex: number) => {
      const currentState = playbackStateRef.current;
      if (
        !mountedRef.current ||
        currentState.index !== fromIndex ||
        currentState.pendingIndex !== nextIndex ||
        currentState.view !== "playing" ||
        currentState.paused
      ) {
        return;
      }

      setIndex(nextIndex);
      setPendingIndex(null);
      pendingPreviewReadyRef.current = null;
    },
    []
  );

  const handlePendingPreviewReady = useCallback(() => {
    const currentState = playbackStateRef.current;
    if (currentState.pendingIndex !== null) {
      pendingPreviewReadyRef.current = currentState.pendingIndex;
      startTransition(currentState.index, currentState.pendingIndex);
    }
  }, [startTransition]);

  const handlePreviewError = useCallback(
    (photoIndex: number) => {
      const failedPhoto = galleryPhotos[photoIndex];
      if (failedPhoto) {
        previewPreloadsRef.current.set(failedPhoto.id, Promise.resolve(false));
      }
      const currentState = playbackStateRef.current;
      if (photoIndex === currentState.pendingIndex) {
        pendingPreviewReadyRef.current = null;
      }
      if (
        photoIndex === currentState.index ||
        photoIndex === currentState.pendingIndex
      ) {
        requestNextTransition(currentState.index, true);
      }
    },
    [galleryPhotos, requestNextTransition]
  );

  // Keep asynchronous playback callbacks from updating an unmounted overlay.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (view !== "intro") {
      return;
    }
    const timeout = window.setTimeout(() => setView("playing"), INTRO_MS);
    return () => window.clearTimeout(timeout);
  }, [view]);

  const revealControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
    }
    hideTimerRef.current = setTimeout(() => {
      if (
        !(
          controlsHoveredRef.current ||
          overlayRef.current?.querySelector(
            "[data-wander-control]:focus-within"
          )
        )
      ) {
        setControlsVisible(false);
      }
    }, CONTROLS_HIDE_MS);
  }, []);

  const handleControlsEnter = () => {
    controlsHoveredRef.current = true;
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
    }
    setControlsVisible(true);
  };

  const handleControlsLeave = () => {
    controlsHoveredRef.current = false;
    revealControls();
  };

  const handleMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    controlsHoveredRef.current = Boolean(
      (event.target as HTMLElement).closest("[data-wander-control]")
    );
    revealControls();
  };

  // Focus the modal root so keyboard shortcuts work immediately after opening.
  useEffect(() => {
    overlayRef.current?.focus();
  }, []);

  // Advance only after the next preview is ready, so a slow original cannot create a blank frame.
  useEffect(() => {
    if (
      !(view === "playing" && photo) ||
      playbackPaused ||
      isParallax ||
      isHamsterWheel
    ) {
      return;
    }
    const timeout = window.setTimeout(
      () => {
        if (index >= galleryPhotos.length - 1) {
          if (
            mountedRef.current &&
            playbackStateRef.current.index === index &&
            playbackStateRef.current.view === "playing" &&
            !playbackStateRef.current.paused
          ) {
            completeRound();
          }
          return;
        }
        requestNextTransition(index);
      },
      Math.max(1, intervalMs)
    );
    return () => {
      window.clearTimeout(timeout);
    };
  }, [
    index,
    intervalMs,
    completeRound,
    playbackPaused,
    isParallax,
    isHamsterWheel,
    photo,
    requestNextTransition,
    galleryPhotos.length,
    view,
  ]);

  useEffect(() => {
    if (
      view === "playing" &&
      !playbackPaused &&
      pendingIndex !== null &&
      pendingPreviewReadyRef.current === pendingIndex
    ) {
      startTransition(index, pendingIndex);
    }
  }, [index, playbackPaused, pendingIndex, startTransition, view]);

  // Preload the current frame and the next two frames with the exact URLs used by the two image layers.
  useEffect(() => {
    if (isParallax) {
      return;
    }
    const nextPhotos = galleryPhotos.slice(index, index + 3);
    for (const item of nextPhotos) {
      preloadWanderAsset(item, "preview");
    }
    for (const item of nextPhotos) {
      preloadWanderAsset(item, "full");
    }
  }, [index, isParallax, preloadWanderAsset, galleryPhotos]);

  // Record a valid exposure once a photo has stayed on screen for two seconds.
  useEffect(() => {
    if (!photo || isParallax) {
      return;
    }
    const timeout = window.setTimeout(() => {
      recordWanderExposure({ photoId: photo.id, source: "wander" }).catch(
        () => undefined
      );
    }, EXPOSURE_MS);
    return () => window.clearTimeout(timeout);
  }, [isParallax, photo]);

  const togglePaused = useCallback(() => {
    setPaused((value) => !value);
    revealControls();
  }, [revealControls]);
  const keyboardBrowse = useCallback(() => {
    if (isParallax) {
      setPaused(true);
    }
    revealControls();
  }, [isParallax, revealControls]);
  useWanderKeyboard({
    onClose: dismiss,
    onKeyboardBrowse: keyboardBrowse,
    onTogglePause: togglePaused,
    view,
  });

  useEffect(() => {
    revealControls();
    return () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
      }
    };
  }, [revealControls]);

  const currentPhoto = photo;

  const themeTitle = t(session.titleKey, session.titleParams ?? {});
  const themeSubtitle = session.subtitleKey
    ? t(session.subtitleKey, session.subtitleParams ?? {})
    : null;
  const overlaySurfaceClass = isHamsterWheel
    ? "wander-hamster-overlay"
    : "bg-[#070709] text-white";
  const mutedTextClass = isHamsterWheel
    ? "wander-hamster-muted"
    : "text-white/50";
  const introMutedTextClass = isHamsterWheel
    ? "wander-hamster-muted"
    : "text-white/45";
  const secondaryTextClass = isHamsterWheel
    ? "wander-hamster-secondary"
    : "text-white/65";
  const photoHint = isParallax
    ? "wander.parallaxControlsHint"
    : "wander.controlsHint";
  const stageClass = isHamsterWheel ? "wander-hamster-stage" : "";

  return createPortal(
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: the full-screen dialog owns dismissal gestures across its backdrop.
    <div
      aria-label={t("wander.experience")}
      aria-modal="true"
      className={`fixed inset-0 z-[10000] h-dvh min-h-0 min-w-0 overflow-hidden ${overlaySurfaceClass} outline-none ${controlsVisible ? "cursor-default" : "cursor-none"}`}
      data-wander-mode={session.mode}
      data-wander-presentation={isParallax ? "parallax" : "slideshow"}
      onMouseMove={handleMouseMove}
      onPointerDown={revealControls}
      onWheel={(event) => {
        if (!(isParallax || inspectedPhoto)) {
          event.preventDefault();
        }
        revealControls();
      }}
      ref={overlayRef}
      role="dialog"
      tabIndex={-1}
    >
      {currentPhoto && !isParallax && (
        <div className="absolute inset-0">
          <img
            alt=""
            aria-hidden="true"
            className="h-full w-full scale-110 object-cover opacity-20 blur-3xl"
            height={currentPhoto.height || 1}
            src={toLocalMediaUrl(
              currentPhoto.thumbnailPath ?? currentPhoto.path
            )}
            width={currentPhoto.width || 1}
          />
          <div className="absolute inset-0 bg-black/35" />
        </div>
      )}

      {isParallax && (
        <WanderParallax
          durationMs={{ slow: 90_000, normal: 60_000, fast: 45_000 }[flowSpeed]}
          exposedIds={exposedIdsRef.current}
          exposureEnabled={view === "playing" && !inspectedPhoto}
          onComplete={completeRound}
          onError={failGalleryPhoto}
          onInspect={inspectPhoto}
          onPause={pauseGallery}
          onProgress={setGalleryProgress}
          paused={
            playbackPaused || view !== "playing" || Boolean(inspectedPhoto)
          }
          photos={galleryPhotos}
          previews={previews}
        />
      )}
      {view === "intro" && (
        <div className="pointer-events-none absolute inset-0 z-10 flex min-h-full min-w-0 flex-col items-center justify-center gap-3 overflow-y-auto bg-black/40 px-4 py-16 text-center sm:px-8">
          <div
            className={`text-[11px] uppercase tracking-[0.12em] ${introMutedTextClass}`}
          >
            {t("wander.roundLabel", { round: roundNumber })}
          </div>
          <h2 className="max-w-full break-words font-medium text-2xl sm:text-3xl">
            {themeTitle}
          </h2>
          {themeSubtitle && (
            <p
              className={`max-w-full break-words text-sm ${secondaryTextClass}`}
            >
              {themeSubtitle}
            </p>
          )}
        </div>
      )}

      {view === "playing" && isHamsterWheel && (
        <div
          className={`absolute inset-0 flex min-h-0 min-w-0 items-center justify-center px-4 pt-20 pb-16 sm:px-10 sm:pt-24 sm:pb-20 ${stageClass}`}
        >
          <div className={`wander-hamster-wheel ${paused ? "is-paused" : ""}`}>
            <HamsterWheelLoader label={themeTitle} />
          </div>
        </div>
      )}

      {view === "playing" && !isHamsterWheel && !isParallax && (
        <div className="absolute inset-0 flex min-h-0 min-w-0 items-center justify-center px-4 pt-20 pb-16 sm:px-10 sm:pt-24 sm:pb-20">
          <div className="relative h-full min-h-0 w-full min-w-0">
            {currentPhoto && (
              <WanderImageStack
                className="opacity-100"
                key={currentPhoto.id}
                layer="current"
                onPreviewError={() => handlePreviewError(index)}
                photo={currentPhoto}
                previewUrl={previews?.[currentPhoto.id]}
              />
            )}
            {pendingPhoto && (
              <WanderImageStack
                className="opacity-0"
                key={pendingPhoto.id}
                layer="pending"
                onPreviewError={() => {
                  if (pendingIndex !== null) {
                    handlePreviewError(pendingIndex);
                  }
                }}
                onPreviewReady={handlePendingPreviewReady}
                photo={pendingPhoto}
                previewUrl={previews?.[pendingPhoto.id]}
              />
            )}
          </div>
        </div>
      )}

      {view === "playing" && hintVisible && (
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute inset-x-0 bottom-14 z-10 px-4 text-center text-[11px] transition-opacity duration-500 sm:bottom-16 ${mutedTextClass}`}
        >
          {t(isHamsterWheel ? "wander.hamsterWheelControlsHint" : photoHint)}
        </div>
      )}

      {view === "playing" && paused && !inspectedPhoto && (
        <div
          aria-live="polite"
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
          role="status"
        >
          <span
            className={`rounded-full px-4 py-2 text-sm backdrop-blur-sm ${isHamsterWheel ? "wander-hamster-paused" : "bg-black/45 text-white/80"}`}
          >
            {t("wander.paused")}
          </span>
        </div>
      )}

      <header
        className={`absolute inset-x-0 top-0 flex min-w-0 items-start justify-between gap-3 px-4 pt-4 pb-14 transition-opacity duration-300 sm:px-6 sm:pt-6 sm:pb-16 ${isHamsterWheel ? "wander-hamster-header" : "bg-gradient-to-b from-black/65 to-transparent"} ${controlsVisible ? "opacity-100" : "pointer-events-none opacity-0"}`}
        data-wander-control
      >
        <div className="min-w-0">
          <div
            className={`text-[10px] uppercase tracking-[0.12em] ${mutedTextClass}`}
          >
            {t("wander.roundLabel", { round: roundNumber })}
          </div>
          <h1 className="mt-1 break-words font-medium text-base sm:text-lg">
            {themeTitle}
          </h1>
          {themeSubtitle && (
            <p className={`mt-1 break-words text-xs ${secondaryTextClass}`}>
              {themeSubtitle}
            </p>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-label={t("close")}
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${isHamsterWheel ? "wander-hamster-close" : "bg-black/30 text-white/70 hover:bg-black/55 hover:text-white"}`}
              onBlur={handleControlsLeave}
              onClick={dismiss}
              onFocus={handleControlsEnter}
              type="button"
            >
              <X className="h-5 w-5" />
            </button>
          </TooltipTrigger>
          <TooltipContent className="z-[10020]">{t("close")}</TooltipContent>
        </Tooltip>
      </header>

      {view === "playing" && !isHamsterWheel && (
        <footer
          className={`absolute inset-x-0 bottom-0 flex min-w-0 flex-wrap items-center justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent px-4 pt-12 pb-4 transition-opacity duration-300 sm:flex-nowrap sm:px-6 sm:pt-14 sm:pb-5 ${controlsVisible ? "opacity-100" : "pointer-events-none opacity-0"}`}
          data-wander-control
        >
          {preparingNext ? (
            <span className="text-white/45 text-xs">
              {t("wander.preparingNext")}
            </span>
          ) : (
            <span className="text-white/45 text-xs tabular-nums">
              {isParallax
                ? `${galleryProgress}%`
                : `${index + 1} / ${galleryPhotos.length}`}
            </span>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                aria-label={t(paused ? "wander.play" : "wander.pause")}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/15 text-white/90 hover:bg-white/20"
                disabled={saving || preparingNext}
                onBlur={handleControlsLeave}
                onClick={togglePaused}
                onFocus={handleControlsEnter}
                type="button"
              >
                {paused ? (
                  <Play className="h-4 w-4" />
                ) : (
                  <Pause className="h-4 w-4" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent className="z-[10020]">
              {t(paused ? "wander.play" : "wander.pause")}
            </TooltipContent>
          </Tooltip>
          {isParallax && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  aria-label={t("wander.nextRound")}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/15 text-white/90 hover:bg-white/20"
                  disabled={saving || preparingNext}
                  onBlur={handleControlsLeave}
                  onClick={completeRound}
                  onFocus={handleControlsEnter}
                  type="button"
                >
                  <SkipForward className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="z-[10020]">
                {t("wander.nextRound")}
              </TooltipContent>
            </Tooltip>
          )}
          <button
            aria-label={t("wander.saveRound")}
            className="ml-auto flex h-9 min-w-0 max-w-full items-center justify-center gap-1.5 rounded-full border border-white/10 bg-white/15 px-4 text-white/90 text-xs hover:bg-white/20 hover:text-white disabled:opacity-50"
            disabled={saving}
            onBlur={handleControlsLeave}
            onClick={onSave}
            onFocus={handleControlsEnter}
            type="button"
          >
            <Save className="h-3.5 w-3.5" />
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {saving ? t("wander.saving") : t("wander.saveRound")}
            </span>
          </button>
        </footer>
      )}

      {view === "playing" && !isHamsterWheel && galleryPhotos.length > 0 && (
        <div
          aria-label={t("wander.progress")}
          aria-valuemax={isParallax ? 100 : galleryPhotos.length}
          aria-valuemin={isParallax ? 0 : 1}
          aria-valuenow={isParallax ? galleryProgress : index + 1}
          className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-px bg-white/10"
          data-wander-progress
          role="progressbar"
        >
          <div
            className="h-full bg-white/45 transition-[width] duration-500"
            style={{
              width: `${isParallax ? galleryProgress : ((index + 1) / galleryPhotos.length) * 100}%`,
            }}
          />
        </div>
      )}
      {inspectedPhoto && (
        <div
          aria-label={t("wander.openPhoto", {
            filename: inspectedPhoto.filename,
          })}
          aria-modal="true"
          className="absolute inset-0 z-30 flex min-h-0 min-w-0 flex-col bg-background p-3 text-foreground sm:p-6"
          ref={inspectRef}
          role="dialog"
          tabIndex={-1}
        >
          <div className="flex min-w-0 items-center justify-end pb-3">
            <button
              className="max-w-full rounded-md bg-secondary px-4 py-2 text-sm [overflow-wrap:anywhere]"
              onClick={closeInspection}
              type="button"
            >
              {t("wander.backToGallery")}
            </button>
          </div>
          <div className="relative min-h-0 min-w-0 flex-1">
            <ZoomableImage
              alt={inspectedPhoto.filename}
              filePath={inspectedPhoto.path}
            />
          </div>
        </div>
      )}
    </div>,
    document.body
  );
}
