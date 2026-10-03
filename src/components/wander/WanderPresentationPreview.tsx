/** biome-ignore-all lint/style/useFilenamingConvention: React component naming. */
import { Pause, Play, RotateCcw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import type { WanderSettings } from "@/types/wander";
import { wanderColumnOffset } from "./wander-motion";
import { WanderPreviewScene } from "./wander-preview-scenes";

const PREVIEW_COLUMNS = Array.from({ length: 4 }, (_, column) =>
  Array.from({ length: 3 }, (_, row) => column + row * 4)
);

export function WanderPresentationPreview({
  presentation,
  flowSpeed,
  intervalSeconds,
  suspended = false,
}: Pick<WanderSettings, "presentation" | "flowSpeed" | "intervalSeconds"> & {
  suspended?: boolean;
}) {
  const { t } = useTranslation();
  const systemReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const appReducedMotion = useReducedMotion();
  const reducedMotion = systemReducedMotion || appReducedMotion;
  const stageRef = useRef<HTMLDivElement>(null);
  const columnsRef = useRef<Array<HTMLDivElement | null>>([]);
  const progressRef = useRef(0);
  const slideRef = useRef(0);
  const [slide, setSlide] = useState(0);
  const [height, setHeight] = useState(0);
  const [visible, setVisible] = useState(false);
  const [foreground, setForeground] = useState(
    () => document.visibilityState === "visible" && document.hasFocus()
  );
  const [phase, setPhase] = useState<"playing" | "paused" | "finished">(
    "playing"
  );
  const duration =
    presentation === "parallax"
      ? { slow: 15_000, normal: 10_000, fast: 7500 }[flowSpeed]
      : intervalSeconds * 3000;
  const playing =
    !(reducedMotion || suspended) &&
    visible &&
    foreground &&
    phase === "playing";

  const paint = useCallback(
    (progress: number) => {
      progressRef.current = progress;
      if (stageRef.current) {
        stageRef.current.dataset.progress = String(progress);
      }
      if (presentation === "parallax") {
        columnsRef.current.forEach((column, index) => {
          if (column) {
            const travel = column.scrollHeight - height;
            column.style.transform = `translate3d(0, ${wanderColumnOffset(travel, progress, index)}px, 0)`;
          }
        });
      } else {
        const nextSlide = Math.min(2, Math.floor(progress * 3));
        if (slideRef.current !== nextSlide) {
          slideRef.current = nextSlide;
          setSlide(nextSlide);
        }
      }
    },
    [height, presentation]
  );

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }
    const measure = () => setHeight(stage.clientHeight);
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(stage);
    const intersection = new IntersectionObserver(([entry]) =>
      setVisible(entry.isIntersecting && entry.intersectionRatio > 0)
    );
    intersection.observe(stage);
    const updateForeground = () =>
      setForeground(
        document.visibilityState === "visible" && document.hasFocus()
      );
    const blur = () => setForeground(false);
    window.addEventListener("focus", updateForeground);
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", updateForeground);
    return () => {
      resize.disconnect();
      intersection.disconnect();
      window.removeEventListener("focus", updateForeground);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", updateForeground);
    };
  }, []);

  useLayoutEffect(() => paint(progressRef.current), [paint]);

  useEffect(() => {
    if (!playing) {
      return;
    }
    let frame = 0;
    let previous: number | null = null;
    const tick = (now: number) => {
      if (previous !== null) {
        paint(
          Math.min(
            1,
            progressRef.current + Math.min(100, now - previous) / duration
          )
        );
      }
      previous = now;
      if (progressRef.current >= 1) {
        setPhase("finished");
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [duration, paint, playing]);

  const replay = () => {
    paint(0);
    setPhase("playing");
  };
  const pauseLabel = t(
    phase === "playing" ? "wander.preview.pause" : "wander.preview.resume"
  );
  return (
    <div className="min-w-0 py-3" data-wander-preview={presentation}>
      <div
        aria-label={t("wander.preview.label")}
        className="relative aspect-video w-full max-w-[360px] overflow-hidden rounded-md border border-border bg-background"
        data-preview-phase={phase}
        data-preview-playing={playing}
        ref={stageRef}
        role="img"
      >
        {presentation === "parallax" ? (
          <div className="flex items-start gap-1.5 px-1.5">
            {PREVIEW_COLUMNS.map((scenes, columnIndex) => (
              <div
                className="flex min-w-0 flex-1 flex-col gap-1.5"
                data-preview-column
                key={scenes[0]}
                ref={(node) => {
                  columnsRef.current[columnIndex] = node;
                }}
              >
                {scenes.map((index, row) => (
                  <div
                    className="shrink-0 overflow-hidden rounded-sm"
                    key={index}
                    style={{
                      height:
                        height *
                        ([0.54, 0.72, 0.6, 0.8][columnIndex] +
                          (row % 2) * 0.06),
                    }}
                  >
                    <WanderPreviewScene
                      className="h-full w-full"
                      index={index}
                    />
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : (
          [0, 1, 2].map((index) => (
            <div
              className={`absolute inset-0 flex items-center justify-center p-3 transition-opacity duration-500 motion-reduce:transition-none ${slide === index ? "opacity-100" : "opacity-0"}`}
              data-preview-slide={index}
              key={index}
            >
              <WanderPreviewScene
                className="aspect-[3/2] max-h-full max-w-full rounded-sm"
                fit="meet"
                index={index}
              />
            </div>
          ))
        )}
      </div>
      <div className="mt-2 flex w-full min-w-0 max-w-[360px] items-start justify-between gap-2">
        <div className="min-w-0 text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
          <p>{t(`wander.preview.${presentation}Description`)}</p>
          {reducedMotion ? (
            <p className="mt-1">{t("wander.preview.reducedMotion")}</p>
          ) : (
            presentation === "parallax" && (
              <p className="mt-1 text-muted-foreground/70">
                {t("wander.preview.accelerated")}
              </p>
            )
          )}
        </div>
        {!reducedMotion && (
          <div className="flex shrink-0 gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  aria-label={pauseLabel}
                  className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-accent disabled:opacity-40"
                  disabled={phase === "finished"}
                  onClick={() =>
                    setPhase((current) =>
                      current === "playing" ? "paused" : "playing"
                    )
                  }
                  type="button"
                >
                  {phase === "playing" ? (
                    <Pause className="h-3.5 w-3.5" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent>{pauseLabel}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  aria-label={t("wander.preview.replay")}
                  className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-accent"
                  onClick={replay}
                  type="button"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{t("wander.preview.replay")}</TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>
    </div>
  );
}
