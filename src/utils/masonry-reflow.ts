import type { MasonryItem } from "@/hooks/useMasonryLayout";

interface MasonryReflowInput {
  idToIndexMap: Map<number, number>;
  nextPaddingTop: number;
  positions: MasonryItem[];
  previousItems: Array<{ id: number }>;
  previousPaddingTop: number;
  previousPositions: MasonryItem[];
  scrollTop: number;
  topInset: number;
}

/** Resolve against the old geometry before committing a shorter scroll surface. */
export function getMasonryReflowScrollTop({
  idToIndexMap,
  nextPaddingTop,
  positions,
  previousItems,
  previousPaddingTop,
  previousPositions,
  scrollTop,
  topInset,
}: MasonryReflowInput): number {
  if (scrollTop <= 0) {
    return 0;
  }
  const visibleTop = scrollTop + topInset - previousPaddingTop;
  for (let index = 0; index < previousPositions.length; index++) {
    const previous = previousPositions[index];
    if (previous.top + previous.height <= visibleTop) {
      continue;
    }
    const item = previousItems[index];
    const nextIndex = item ? idToIndexMap.get(item.id) : undefined;
    const next = nextIndex === undefined ? undefined : positions[nextIndex];
    if (next) {
      const viewportOffset = previous.top + previousPaddingTop - scrollTop;
      return next.top + nextPaddingTop - viewportOffset;
    }
  }
  return scrollTop;
}
