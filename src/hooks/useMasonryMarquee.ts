import {
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  useCallback,
  useEffect,
  useState,
} from "react";
import type { MasonryItem } from "@/hooks/useMasonryLayout";
import { binarySearchStart } from "@/utils/masonry-utils";

export interface MasonryMarqueeState {
  startX: number;
  startY: number;
  x: number;
  y: number;
}

export function collectMarqueeSelection<T extends { id: number }>(
  marquee: MasonryMarqueeState,
  positions: MasonryItem[],
  items: T[],
  columnCount: number
): Set<number> {
  const minX = Math.min(marquee.startX, marquee.x);
  const maxX = Math.max(marquee.startX, marquee.x);
  const minY = Math.min(marquee.startY, marquee.y);
  const maxY = Math.max(marquee.startY, marquee.y);
  const selected = new Set<number>();

  if (maxX - minX <= 5 || maxY - minY <= 5) {
    return selected;
  }

  const startIdx = Math.max(0, binarySearchStart(positions, minY) - columnCount);
  for (let i = startIdx; i < positions.length; i++) {
    const pos = positions[i];
    if (pos.top > maxY) {
      break;
    }
    const item = items[i];
    if (!item) {
      continue;
    }
    const itemRight = pos.left + pos.width;
    const itemBottom = pos.top + pos.height;
    if (
      pos.left < maxX &&
      itemRight > minX &&
      pos.top < maxY &&
      itemBottom > minY
    ) {
      selected.add(item.id);
    }
  }
  return selected;
}

interface UseMasonryMarqueeOptions<T extends { id: number }> {
  columnCount: number;
  items: T[];
  onMarqueeSelect?: (ids: Set<number>) => void;
  positions: MasonryItem[];
  scrollRef: RefObject<HTMLDivElement | null>;
}

export function useMasonryMarquee<T extends { id: number }>({
  columnCount,
  items,
  onMarqueeSelect,
  positions,
  scrollRef,
}: UseMasonryMarqueeOptions<T>): {
  handleMarqueeStart: (e: ReactMouseEvent) => void;
  marquee: MasonryMarqueeState | null;
} {
  const [marquee, setMarquee] = useState<MasonryMarqueeState | null>(null);

  const handleMarqueeStart = useCallback(
    (e: ReactMouseEvent) => {
      if (!onMarqueeSelect || e.button !== 0) {
        return;
      }
      const target = e.target as HTMLElement;
      if (target.closest("[data-photo-id]")) {
        return;
      }

      const scrollEl = scrollRef.current;
      if (!scrollEl) {
        return;
      }
      const rect = scrollEl.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top + scrollEl.scrollTop;
      setMarquee({ startX: x, startY: y, x, y });
    },
    [onMarqueeSelect, scrollRef]
  );

  useEffect(() => {
    const activeMarquee = marquee;
    const selectMarquee = onMarqueeSelect;
    const scrollEl = scrollRef.current;
    if (!(activeMarquee && selectMarquee && scrollEl)) {
      return;
    }
    const currentMarquee = activeMarquee;
    const currentScrollEl = scrollEl;
    const currentSelectMarquee = selectMarquee;

    function handleMouseMove(e: MouseEvent) {
      const rect = currentScrollEl.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top + currentScrollEl.scrollTop;
      setMarquee((prev) => (prev ? { ...prev, x, y } : null));
    }

    function handleMouseUp() {
      const selected = collectMarqueeSelection(
        currentMarquee,
        positions,
        items,
        columnCount
      );
      if (selected.size > 0) {
        currentSelectMarquee(selected);
      }
      setMarquee(null);
    }

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [columnCount, items, marquee, onMarqueeSelect, positions, scrollRef]);

  return { handleMarqueeStart, marquee };
}
