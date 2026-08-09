/** biome-ignore-all lint/style/useFilenamingConvention: component names follow the repository's existing React convention. */
import { Save, X } from "lucide-react";
import {
  type MouseEvent,
  useCallback,
  useEffect,
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
import type { WanderSession } from "@/types/wander";
import { preloadImageAsync, toLocalMediaUrl } from "@/utils/local-media-url";

const INTRO_MS = 1200;
const EXPOSURE_MS = 2000;
const CONTROLS_HIDE_MS = 3500;
const HINT_HIDE_MS = 3500;
const WANDER_PRELOAD_CONCURRENCY = 4;

interface WanderOverlayProps {
  intervalMs: number;
  onClose: () => void;
  onRoundComplete: () => void;
  onSave: () => void;
  preparingNext?: boolean;
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
  onTogglePause,
  view,
}: {
  onClose: () => void;
  onTogglePause: () => void;
  view: WanderView;
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.code === "Space" && view === "playing") {
        onTogglePause();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose, onTogglePause, view]);
}

interface WanderImageStackProps {
  className?: string;
  layer: "current" | "pending";
  onPreviewError?: () => void;
  onPreviewReady?: () => void;
  photo: WanderSession["photos"][number];
}

function WanderImageStack({
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

  const previewSrc = toLocalMediaUrl(photo.thumbnailPath ?? photo.path);
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
  const controlsHoveredRef = useRef(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const previewPreloadsRef = useRef(new Map<number, Promise<boolean>>());
  const fullPreloadsRef = useRef(new Map<number, Promise<boolean>>());
  const advanceInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const pendingPreviewReadyRef = useRef<number | null>(null);
  const playbackStateRef = useRef({ index, paused, pendingIndex, view });
  const photo = session.photos[index];
  const isHamsterWheel = session.mode === "hamsterWheel";
  const pendingPhoto =
    pendingIndex === null ? undefined : session.photos[pendingIndex];
  const hintVisible = useWanderHint(view, roundNumber === 1);
  playbackStateRef.current = { index, paused, pendingIndex, view };

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

      const request = preloadImageAsync(
        filePath,
        WANDER_PRELOAD_CONCURRENCY
      ).catch(() => false);
      cache.set(item.id, request);
      return request;
    },
    []
  );

  const findNextReadyPhoto = useCallback(
    async (fromIndex: number): Promise<number | null> => {
      for (
        let nextIndex = fromIndex + 1;
        nextIndex < session.photos.length;
        nextIndex++
      ) {
        const previewLoaded = await preloadWanderAsset(
          session.photos[nextIndex],
          "preview"
        );
        if (previewLoaded) {
          return nextIndex;
        }
      }
      return null;
    },
    [preloadWanderAsset, session.photos]
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
          onRoundComplete();
          return;
        }
        setPendingIndex(nextIndex);
      } finally {
        advanceInFlightRef.current = false;
      }
    },
    [findNextReadyPhoto, onRoundComplete]
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
    [requestNextTransition]
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
      if (!controlsHoveredRef.current) {
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
    if (!(view === "playing" && photo) || paused) {
      return;
    }
    const timeout = window.setTimeout(
      () => {
        if (index >= session.photos.length - 1) {
          if (
            mountedRef.current &&
            playbackStateRef.current.index === index &&
            playbackStateRef.current.view === "playing" &&
            !playbackStateRef.current.paused
          ) {
            onRoundComplete();
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
    onRoundComplete,
    paused,
    photo,
    requestNextTransition,
    session.photos.length,
    view,
  ]);

  useEffect(() => {
    if (
      view === "playing" &&
      !paused &&
      pendingIndex !== null &&
      pendingPreviewReadyRef.current === pendingIndex
    ) {
      startTransition(index, pendingIndex);
    }
  }, [index, paused, pendingIndex, startTransition, view]);

  // Preload the current frame and the next two frames with the exact URLs used by the two image layers.
  useEffect(() => {
    const nextPhotos = session.photos.slice(index, index + 3);
    for (const item of nextPhotos) {
      preloadWanderAsset(item, "preview");
    }
    for (const item of nextPhotos) {
      preloadWanderAsset(item, "full");
    }
  }, [index, preloadWanderAsset, session.photos]);

  // Record a valid exposure once a photo has stayed on screen for two seconds.
  useEffect(() => {
    if (!photo) {
      return;
    }
    const timeout = window.setTimeout(() => {
      recordWanderExposure({ photoId: photo.id, source: "wander" }).catch(
        () => undefined
      );
    }, EXPOSURE_MS);
    return () => window.clearTimeout(timeout);
  }, [photo]);

  const togglePaused = useCallback(() => {
    setPaused((value) => !value);
    revealControls();
  }, [revealControls]);
  useWanderKeyboard({ onClose, onTogglePause: togglePaused, view });

  useEffect(() => {
    revealControls();
    return () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
      }
    };
  }, [revealControls]);

  if (!(photo || isHamsterWheel)) {
    return null;
  }

  const currentPhoto = photo;

  const themeTitle = t(session.titleKey, session.titleParams ?? {});
  const themeSubtitle = session.subtitleKey
    ? t(session.subtitleKey, session.subtitleParams ?? {})
    : null;

  return createPortal(
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: the full-screen dialog owns dismissal gestures across its backdrop.
    <div
      aria-label={t("wander.experience")}
      aria-modal="true"
      className={`fixed inset-0 z-[10000] h-dvh min-h-0 min-w-0 overflow-hidden bg-[#070709] text-white outline-none ${controlsVisible ? "cursor-default" : "cursor-none"}`}
      onMouseMove={handleMouseMove}
      onPointerDown={revealControls}
      onWheel={(event) => {
        event.preventDefault();
        revealControls();
      }}
      ref={overlayRef}
      role="dialog"
      tabIndex={-1}
    >
      {currentPhoto && (
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

      {view === "intro" && (
        <div className="absolute inset-0 flex min-h-full min-w-0 flex-col items-center justify-center gap-3 overflow-y-auto px-4 py-16 text-center sm:px-8">
          <div className="text-[11px] text-white/45 uppercase tracking-[0.12em]">
            {t("wander.roundLabel", { round: roundNumber })}
          </div>
          <h2 className="max-w-full break-words font-medium text-2xl sm:text-3xl">
            {themeTitle}
          </h2>
          {themeSubtitle && (
            <p className="max-w-full break-words text-sm text-white/65">
              {themeSubtitle}
            </p>
          )}
        </div>
      )}

      {view === "playing" && isHamsterWheel && (
        <div className="absolute inset-0 flex min-h-0 min-w-0 items-center justify-center px-4 pt-20 pb-16 sm:px-10 sm:pt-24 sm:pb-20">
          <div className={`wander-hamster-wheel ${paused ? "is-paused" : ""}`}>
            <HamsterWheelLoader label={themeTitle} />
          </div>
        </div>
      )}

      {view === "playing" && !isHamsterWheel && (
        <div className="absolute inset-0 flex min-h-0 min-w-0 items-center justify-center px-4 pt-20 pb-16 sm:px-10 sm:pt-24 sm:pb-20">
          <div className="relative h-full min-h-0 w-full min-w-0">
            {currentPhoto && (
              <WanderImageStack
                className="opacity-100"
                key={currentPhoto.id}
                layer="current"
                onPreviewError={() => handlePreviewError(index)}
                photo={currentPhoto}
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
              />
            )}
          </div>
        </div>
      )}

      {view === "playing" && hintVisible && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-14 z-10 px-4 text-center text-[11px] text-white/50 transition-opacity duration-500 sm:bottom-16"
        >
          {t(
            isHamsterWheel
              ? "wander.hamsterWheelControlsHint"
              : "wander.controlsHint"
          )}
        </div>
      )}

      {view === "playing" && paused && (
        <div
          aria-live="polite"
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
          role="status"
        >
          <span className="rounded-full bg-black/45 px-4 py-2 text-sm text-white/80 backdrop-blur-sm">
            {t("wander.paused")}
          </span>
        </div>
      )}

      <header
        className={`absolute inset-x-0 top-0 flex min-w-0 items-start justify-between gap-3 bg-gradient-to-b from-black/65 to-transparent px-4 pt-4 pb-14 transition-opacity duration-300 sm:px-6 sm:pt-6 sm:pb-16 ${controlsVisible ? "opacity-100" : "pointer-events-none opacity-0"}`}
        data-wander-control
      >
        <div className="min-w-0">
          <div className="text-[10px] text-white/50 uppercase tracking-[0.12em]">
            {t("wander.roundLabel", { round: roundNumber })}
          </div>
          <h1 className="mt-1 break-words font-medium text-base sm:text-lg">
            {themeTitle}
          </h1>
          {themeSubtitle && (
            <p className="mt-1 break-words text-white/65 text-xs">
              {themeSubtitle}
            </p>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-label={t("close")}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/30 text-white/70 hover:bg-black/55 hover:text-white"
              onBlur={handleControlsLeave}
              onClick={onClose}
              onFocus={handleControlsEnter}
              type="button"
            >
              <X className="h-5 w-5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t("close")}</TooltipContent>
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
              {index + 1} / {session.photos.length}
            </span>
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
            <span className="min-w-0 truncate">
              {saving ? t("wander.saving") : t("wander.saveRound")}
            </span>
          </button>
        </footer>
      )}

      {view === "playing" && !isHamsterWheel && (
        <div
          aria-label={t("wander.progress")}
          aria-valuemax={session.photos.length}
          aria-valuemin={1}
          aria-valuenow={index + 1}
          className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-px bg-white/10"
          data-wander-progress
          role="progressbar"
        >
          <div
            className="h-full bg-white/45 transition-[width] duration-500"
            style={{ width: `${((index + 1) / session.photos.length) * 100}%` }}
          />
        </div>
      )}
    </div>,
    document.body
  );
}
