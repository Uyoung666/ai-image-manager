/** biome-ignore-all lint/style/useFilenamingConvention: React component naming. */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { recordWanderExposure } from "@/actions/wander";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { WanderPhoto } from "@/types/wander";
import { wanderPreviewCandidates } from "./wander-media";
import { wanderColumnOffset, wanderProgressForOffset } from "./wander-motion";

export function wanderColumnCount(width: number, count: number): number {
  const desired =
    1 + [520, 800, 1100].filter((breakpoint) => width >= breakpoint).length;
  return Math.max(1, Math.min(desired, Math.floor(count / 3)));
}

interface WanderParallaxProps {
  durationMs: number;
  exposedIds: Set<number>;
  exposureEnabled: boolean;
  onComplete: () => void;
  onError: (id: number) => void;
  onInspect: (photo: WanderPhoto) => void;
  onPause: () => void;
  onProgress: (progress: number) => void;
  paused: boolean;
  photos: WanderPhoto[];
  previews?: Record<number, string>;
}

export function WanderParallax({
  durationMs,
  exposureEnabled,
  exposedIds,
  onComplete,
  onError,
  onInspect,
  onPause,
  onProgress,
  paused,
  photos,
  previews,
}: WanderParallaxProps) {
  const { t } = useTranslation();
  const stageRef = useRef<HTMLDivElement>(null);
  const columnsRef = useRef<Array<HTMLDivElement | null>>([]);
  const progressRef = useRef(0);
  const reportedRef = useRef(-1);
  const completedRef = useRef(false);
  const draggingRef = useRef(false);
  const keyboardNavigationRef = useRef(false);
  const [size, setSize] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });
  const [loaded, setLoaded] = useState<Set<number>>(() => new Set());
  const count = wanderColumnCount(size.width, photos.length);
  const columns = useMemo(() => {
    const result: WanderPhoto[][] = Array.from({ length: count }, () => []);
    photos.forEach((photo, index) => {
      result[index % count].push(photo);
    });
    return result;
  }, [count, photos]);
  const ready = photos.every((photo) => loaded.has(photo.id));

  useEffect(() => {
    const trackNavigation = (event: KeyboardEvent) => {
      keyboardNavigationRef.current = event.key === "Tab";
    };
    document.addEventListener("keydown", trackNavigation, true);
    return () => document.removeEventListener("keydown", trackNavigation, true);
  }, []);

  const paint = useCallback(
    (value: number) => {
      const progress = Math.max(0, Math.min(1, value));
      progressRef.current = progress;
      for (const [columnIndex, column] of columnsRef.current.entries()) {
        if (column) {
          const travel = Math.max(0, column.scrollHeight - size.height);
          column.style.transform = `translate3d(0, ${wanderColumnOffset(travel, progress, columnIndex)}px, 0)`;
        }
      }
      const percent = Math.round(progress * 100);
      if (percent !== reportedRef.current) {
        reportedRef.current = percent;
        onProgress(percent);
      }
    },
    [onProgress, size.height]
  );

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }
    const measure = () =>
      setSize({
        width: stage.clientWidth || window.innerWidth,
        height: stage.clientHeight || window.innerHeight,
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    columnsRef.current.length = columns.length;
    paint(progressRef.current);
  }, [paint, columns]);

  useEffect(() => {
    if (paused || !ready || completedRef.current) {
      return;
    }
    let frame = 0;
    let previous: number | null = null;
    const tick = (now: number) => {
      if (previous !== null) {
        paint(progressRef.current + Math.min(100, now - previous) / durationMs);
      }
      previous = now;
      if (progressRef.current >= 1) {
        completedRef.current = true;
        onComplete();
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [durationMs, onComplete, paint, paused, ready]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }
    const move = (delta: number) => {
      onPause();
      completedRef.current = false;
      const travel = Math.max(
        size.height,
        ...columnsRef.current.map(
          (column) => (column?.scrollHeight ?? 0) - size.height
        )
      );
      paint(progressRef.current + delta / travel);
    };
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey) {
        return;
      }
      event.preventDefault();
      move(event.deltaY * ([1, 16, size.height][event.deltaMode] ?? 1));
    };
    let touchY: number | null = null;
    const touchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY ?? null;
      draggingRef.current = false;
    };
    const touchMove = (event: TouchEvent) => {
      const next = event.touches[0]?.clientY;
      if (touchY === null || next === undefined) {
        return;
      }
      event.preventDefault();
      const delta = touchY - next;
      if (Math.abs(delta) > 2) {
        draggingRef.current = true;
      }
      move(delta);
      touchY = next;
    };
    stage.addEventListener("wheel", wheel, { passive: false });
    stage.addEventListener("touchstart", touchStart, { passive: true });
    stage.addEventListener("touchmove", touchMove, { passive: false });
    return () => {
      stage.removeEventListener("wheel", wheel);
      stage.removeEventListener("touchstart", touchStart);
      stage.removeEventListener("touchmove", touchMove);
    };
  }, [onPause, paint, size.height]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!(stage && exposureEnabled)) {
      return;
    }
    const timers = new Map<number, ReturnType<typeof setTimeout>>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = Number((entry.target as HTMLElement).dataset.photoId);
          const visible =
            entry.isIntersecting &&
            entry.intersectionRatio >= 0.5 &&
            loaded.has(id);
          if (!visible) {
            clearTimeout(timers.get(id));
            timers.delete(id);
          } else if (!(exposedIds.has(id) || timers.has(id))) {
            timers.set(
              id,
              setTimeout(() => {
                timers.delete(id);
                exposedIds.add(id);
                recordWanderExposure({ photoId: id, source: "wander" }).catch(
                  () => undefined
                );
              }, 2000)
            );
          }
        }
      },
      { root: stage, threshold: [0, 0.5] }
    );
    const currentIds = new Set(columns.flat().map((photo) => photo.id));
    for (const card of stage.querySelectorAll("[data-photo-id]")) {
      if (!currentIds.has(Number((card as HTMLElement).dataset.photoId))) {
        continue;
      }
      observer.observe(card);
    }
    return () => {
      observer.disconnect();
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
    };
  }, [exposureEnabled, exposedIds, loaded, columns]);

  return (
    <div
      className="fade-in absolute inset-0 min-h-0 min-w-0 animate-in touch-none overflow-hidden duration-500 motion-reduce:animate-none"
      data-ready={ready}
      data-wander-parallax
      ref={stageRef}
    >
      <div className="flex min-w-0 items-start gap-3 px-3 sm:gap-4 sm:px-4">
        {columns.map((column, columnIndex) => (
          <div
            className="relative flex min-w-0 flex-1 flex-col gap-3 will-change-transform sm:gap-4"
            data-wander-column
            data-wander-direction={columnIndex % 2 === 0 ? "up" : "down"}
            key={column[0].id}
            ref={(node) => {
              columnsRef.current[columnIndex] = node;
            }}
          >
            {column.map((photo, photoIndex) => (
              <Tooltip key={photo.id}>
                <TooltipTrigger asChild>
                  <button
                    aria-label={t("wander.openPhoto", {
                      filename: photo.filename,
                    })}
                    className="relative w-full shrink-0 overflow-hidden rounded-lg bg-secondary outline-none ring-inset hover:ring-2 hover:ring-primary/60 focus-visible:ring-2 focus-visible:ring-primary"
                    data-photo-id={photo.id}
                    onClick={() => {
                      if (!draggingRef.current) {
                        onInspect(photo);
                      }
                      draggingRef.current = false;
                    }}
                    onFocus={(event) => {
                      if (!keyboardNavigationRef.current) {
                        return;
                      }
                      keyboardNavigationRef.current = false;
                      onPause();
                      const stage = stageRef.current;
                      const columnElement = columnsRef.current[columnIndex];
                      if (!(stage && columnElement)) {
                        return;
                      }
                      // Browser focus scrolling must not compete with our transforms.
                      stage.scrollTop = 0;
                      const bounds =
                        event.currentTarget.getBoundingClientRect();
                      const stageBounds = stage.getBoundingClientRect();
                      if (
                        bounds.top >= stageBounds.top + 60 &&
                        bounds.bottom <= stageBounds.bottom - 60
                      ) {
                        return;
                      }
                      const travel = columnElement.scrollHeight - size.height;
                      if (travel > 0) {
                        paint(
                          wanderProgressForOffset(
                            travel,
                            event.currentTarget.offsetTop -
                              (size.height - event.currentTarget.offsetHeight) /
                                2,
                            columnIndex
                          )
                        );
                      }
                    }}
                    onPointerDown={(event) => {
                      if (event.pointerType !== "touch") {
                        draggingRef.current = false;
                      }
                    }}
                    style={{
                      height: Math.max(
                        160,
                        size.height *
                          ([0.54, 0.72, 0.6, 0.8][columnIndex] +
                            (photoIndex % 2) * 0.06)
                      ),
                    }}
                    type="button"
                  >
                    {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: image load/error handlers track readiness. */}
                    <img
                      alt={photo.filename}
                      className="pointer-events-none h-full w-full object-cover"
                      draggable={false}
                      height={photo.height}
                      onError={() => onError(photo.id)}
                      onLoad={() =>
                        setLoaded((previous) => new Set(previous).add(photo.id))
                      }
                      src={
                        previews?.[photo.id] ??
                        wanderPreviewCandidates(photo)[0]
                      }
                      width={photo.width}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="z-[10020]">
                  {photo.filename}
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
