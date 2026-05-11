import { useCallback, useEffect, useRef, useState } from "react";
import Lightbox from "yet-another-react-lightbox";
// @ts-expect-error - no type declarations for lightbox CSS
import "yet-another-react-lightbox/styles.css";

interface Photo {
  filename: string;
  height: number;
  id: number;
  path: string;
  width: number;
}

interface PhotoLightboxProps {
  index: number;
  onClose: () => void;
  open: boolean;
  photos: Photo[];
}

const SLIDESHOW_DELAYS = [
  { label: "3s", value: 3000 },
  { label: "5s", value: 5000 },
  { label: "10s", value: 10000 },
];

function toLocalMediaUrl(filePath: string): string {
  const encoded = filePath
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `local-media://${encoded}`;
}

export function PhotoLightbox({
  photos,
  index,
  open,
  onClose,
}: PhotoLightboxProps) {
  const [photoIndex, setPhotoIndex] = useState(index);
  const [playing, setPlaying] = useState(false);
  const [delay, setDelay] = useState(5000);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const programmaticRef = useRef(false);

  useEffect(() => {
    setPhotoIndex(index);
  }, [index]);

  useEffect(() => {
    if (!open) {
      setPlaying(false);
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
  }, [open]);

  // Clear timer when playing changes to false
  useEffect(() => {
    if (!playing && timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, [playing]);

  // Slideshow auto-advance
  useEffect(() => {
    if (!playing || !open) return;

    timerRef.current = setInterval(() => {
      programmaticRef.current = true;
      setPhotoIndex((prev) => (prev + 1) % photos.length);
    }, delay);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [playing, delay, open, photos.length]);

  const togglePlay = useCallback(() => {
    setPlaying((p) => !p);
  }, []);

  const cycleDelay = useCallback(() => {
    const currentIdx = SLIDESHOW_DELAYS.findIndex((d) => d.value === delay);
    const nextIdx = (currentIdx + 1) % SLIDESHOW_DELAYS.length;
    setDelay(SLIDESHOW_DELAYS[nextIdx].value);
  }, [delay]);

  // Only stop slideshow on user-initiated navigation, not programmatic
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
  }));

  const currentDelayLabel =
    SLIDESHOW_DELAYS.find((d) => d.value === delay)?.label || "5s";

  return (
    <Lightbox
      carousel={{ finite: false }}
      close={onClose}
      index={photoIndex}
      on={{ view: handleViewChange }}
      open={open}
      slides={slides}
      toolbar={{
        buttons: [
          <button
            key="slideshow-play"
            aria-label={playing ? "暂停" : "播放"}
            className="flex h-9 w-9 items-center justify-center rounded-[6px] text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            onClick={togglePlay}
            title={playing ? "暂停幻灯片" : "播放幻灯片"}
          >
            {playing ? (
              <svg
                fill="currentColor"
                height="18"
                viewBox="0 0 24 24"
                width="18"
              >
                <rect height="16" rx="1" width="6" x="5" y="4" />
                <rect height="16" rx="1" width="6" x="13" y="4" />
              </svg>
            ) : (
              <svg
                fill="currentColor"
                height="18"
                viewBox="0 0 24 24"
                width="18"
              >
                <polygon points="5,3 19,12 5,21" />
              </svg>
            )}
          </button>,
          <button
            key="slideshow-delay"
            aria-label={`间隔 ${currentDelayLabel}`}
            className="flex h-9 min-w-[36px] items-center justify-center rounded-[6px] font-[510] text-[11px] text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            onClick={cycleDelay}
            title="切换间隔"
          >
            {currentDelayLabel}
          </button>,
          "close",
        ],
      }}
    />
  );
}
