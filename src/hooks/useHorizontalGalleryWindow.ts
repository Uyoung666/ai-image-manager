import {
  type RefObject,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

const TILE_WIDTH = 104;
/** Fixed-width thumbnails need only a visible range, not 100k measurement objects. */
export function useHorizontalGalleryWindow(
  count: number,
  enabled: boolean,
  ref: RefObject<HTMLDivElement | null>
) {
  const [windowRange, setWindowRange] = useState({
    left: 0,
    width: Math.max(1, window.innerWidth - 24),
  });
  const rangeRef = useRef(windowRange);
  rangeRef.current = windowRange;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!(element && enabled)) {
      return;
    }
    let frame = 0;
    const measure = () => {
      const width =
        element.getBoundingClientRect().width ||
        Math.max(1, window.innerWidth - 24);
      const left = element.scrollLeft;
      setWindowRange((previous) =>
        previous.width === width && previous.left === left
          ? previous
          : { width, left }
      );
    };
    const scroll = () => {
      if (frame) {
        return;
      }
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(element);
    element.addEventListener("scroll", scroll, { passive: true });
    window.addEventListener("resize", measure);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      element.removeEventListener("scroll", scroll);
      window.removeEventListener("resize", measure);
    };
  }, [enabled, ref]);
  const scrollToIndex = useCallback(
    (
      index: number,
      { behavior }: { align?: string; behavior?: ScrollBehavior } = {}
    ) => {
      const element = ref.current;
      if (!element) {
        return;
      }
      const width = rangeRef.current.width;
      const left = Math.max(
        0,
        Math.min(
          count * TILE_WIDTH - width,
          index * TILE_WIDTH - (width - TILE_WIDTH) / 2
        )
      );
      const actualBehavior =
        Math.abs(left - element.scrollLeft) > width * 2 ? "auto" : behavior;
      const nativeScroll = typeof element.scrollTo === "function";
      if (nativeScroll) {
        element.scrollTo({ left, behavior: actualBehavior });
      } else {
        element.scrollLeft = left;
      }
      if (actualBehavior !== "smooth" || !nativeScroll) {
        setWindowRange({ width, left });
      }
    },
    [count, ref]
  );
  const first = Math.max(0, Math.floor(windowRange.left / TILE_WIDTH) - 3);
  const end = Math.min(
    count,
    Math.ceil((windowRange.left + windowRange.width) / TILE_WIDTH) + 3
  );
  return {
    scrollToIndex,
    totalSize: count * TILE_WIDTH,
    items: enabled
      ? Array.from({ length: Math.max(0, end - first) }, (_, offset) => ({
          index: first + offset,
          start: (first + offset) * TILE_WIDTH,
        }))
      : [],
  };
}
