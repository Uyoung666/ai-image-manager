/** biome-ignore-all lint/style/useFilenamingConvention: component names follow the repository's existing React convention. */
import { Save, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { recordWanderExposure } from "@/actions/wander";
import type { WanderSession } from "@/types/wander";
import { preloadImage, toLocalMediaUrl } from "@/utils/local-media-url";

const INTRO_MS = 1200;
const EXPOSURE_MS = 2000;
const CONTROLS_HIDE_MS = 2500;

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
  const [view, setView] = useState<"intro" | "playing">("intro");
  const [index, setIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const photo = session.photos[index];

  // Show the round's theme card briefly before playback begins.
  useEffect(() => {
    if (view !== "intro") {
      return;
    }
    const timeout = window.setTimeout(() => setView("playing"), INTRO_MS);
    return () => window.clearTimeout(timeout);
  }, [view]);

  // Advance playback; the final frame signals the parent to start the next round.
  useEffect(() => {
    if (!(view === "playing" && photo)) {
      return;
    }
    const timeout = window.setTimeout(
      () => {
        if (index >= session.photos.length - 1) {
          onRoundComplete();
          return;
        }
        setLoaded(false);
        setIndex((value) => value + 1);
      },
      Math.max(1, intervalMs)
    );
    return () => window.clearTimeout(timeout);
  }, [index, intervalMs, onRoundComplete, photo, session.photos.length, view]);

  // Preload the next two frames' thumbnails while the current one is visible.
  useEffect(() => {
    for (const item of session.photos.slice(index + 1, index + 3)) {
      preloadImage(item.thumbnailPath ?? item.path);
    }
  }, [index, session.photos]);

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

  // Any keyboard input closes the overlay and must not reach the page beneath.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  useEffect(
    () => () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
      }
    },
    []
  );

  const revealControls = () => {
    setControlsVisible(true);
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
    }
    hideTimerRef.current = setTimeout(
      () => setControlsVisible(false),
      CONTROLS_HIDE_MS
    );
  };

  const handleImageError = () => {
    if (!photo || view !== "playing") {
      return;
    }
    if (index >= session.photos.length - 1) {
      onRoundComplete();
      return;
    }
    setLoaded(false);
    setIndex((value) => value + 1);
  };

  if (!photo) {
    return null;
  }

  const themeTitle = t(session.titleKey, session.titleParams ?? {});
  const themeSubtitle = session.subtitleKey
    ? t(session.subtitleKey, session.subtitleParams ?? {})
    : null;

  return createPortal(
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: the full-screen dialog owns dismissal gestures across its backdrop.
    <div
      aria-label={t("wander.experience")}
      className={`fixed inset-0 z-[10000] overflow-hidden bg-[#070709] text-white outline-none ${controlsVisible ? "cursor-default" : "cursor-none"}`}
      onMouseMove={revealControls}
      onPointerDown={(event) => {
        if (!(event.target as HTMLElement).closest("[data-wander-control]")) {
          onClose();
        }
      }}
      onWheel={(event) => {
        event.preventDefault();
        onClose();
      }}
      role="dialog"
      tabIndex={-1}
    >
      <div className="absolute inset-0">
        <img
          alt=""
          aria-hidden="true"
          className="h-full w-full scale-110 object-cover opacity-20 blur-3xl"
          height={photo.height || 1}
          src={toLocalMediaUrl(photo.thumbnailPath ?? photo.path)}
          width={photo.width || 1}
        />
        <div className="absolute inset-0 bg-black/35" />
      </div>

      {view === "intro" ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center">
          <div className="text-[11px] text-white/45 uppercase tracking-[0.28em]">
            {t("wander.roundLabel", { round: roundNumber })}
          </div>
          <h2 className="font-medium text-3xl">{themeTitle}</h2>
          {themeSubtitle && (
            <p className="text-sm text-white/55">{themeSubtitle}</p>
          )}
        </div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center px-10 pt-24 pb-20">
          {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: load state drives the image crossfade. */}
          <img
            alt={photo.filename}
            className={`max-h-full max-w-full object-contain transition-opacity duration-[600ms] motion-reduce:transition-none ${loaded ? "opacity-100" : "opacity-0"}`}
            height={photo.height || 1}
            key={photo.id}
            onError={handleImageError}
            onLoad={() => setLoaded(true)}
            src={toLocalMediaUrl(photo.path)}
            width={photo.width || 1}
          />
        </div>
      )}

      <header
        className={`absolute inset-x-0 top-0 flex items-start justify-between bg-gradient-to-b from-black/65 to-transparent px-6 pt-6 pb-16 transition-opacity duration-300 ${controlsVisible ? "opacity-100" : "pointer-events-none opacity-0"}`}
        data-wander-control
      >
        <div>
          <div className="text-[10px] text-white/45 uppercase tracking-[0.24em]">
            {t("wander.roundLabel", { round: roundNumber })}
          </div>
          <h1 className="mt-1 font-medium text-lg">{themeTitle}</h1>
          {themeSubtitle && (
            <p className="mt-1 text-white/45 text-xs">{themeSubtitle}</p>
          )}
        </div>
        <button
          aria-label={t("close")}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-black/30 text-white/70 hover:bg-black/55 hover:text-white"
          onClick={onClose}
          type="button"
        >
          <X className="h-5 w-5" />
        </button>
      </header>

      {view === "playing" && (
        <footer
          className={`absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/70 to-transparent px-6 pt-14 pb-5 transition-opacity duration-300 ${controlsVisible ? "opacity-100" : "pointer-events-none opacity-0"}`}
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
            className="flex h-9 items-center gap-1.5 rounded-full bg-white/10 px-4 text-white/75 text-xs hover:bg-white/15 hover:text-white disabled:opacity-50"
            disabled={saving}
            onClick={onSave}
            type="button"
          >
            <Save className="h-3.5 w-3.5" />
            {saving ? t("wander.saving") : t("wander.saveRound")}
          </button>
        </footer>
      )}
    </div>,
    document.body
  );
}
