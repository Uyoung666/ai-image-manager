import type { MasonryItem } from "@/hooks/useMasonryLayout";

export interface MasonryReflowAnchor {
  itemId: number;
  viewportOffset: number;
}

interface MasonryReflowInput {
  anchor?: MasonryReflowAnchor | null;
  idToIndexMap: Map<number, number>;
  nextPaddingTop: number;
  positions: MasonryItem[];
  previousItems: Array<{ id: number }>;
  previousPaddingTop: number;
  previousPositions: MasonryItem[];
  scrollTop: number;
  topInset: number;
}

export function getMasonryReflowAnchor({
  previousItems,
  previousPaddingTop,
  previousPositions,
  scrollTop,
  topInset,
}: Pick<
  MasonryReflowInput,
  | "previousItems"
  | "previousPaddingTop"
  | "previousPositions"
  | "scrollTop"
  | "topInset"
>): MasonryReflowAnchor | null {
  const visibleTop = scrollTop + topInset - previousPaddingTop;
  const index = previousPositions.findIndex(
    (position) => position.top + position.height > visibleTop
  );
  const item = previousItems[index];
  const position = previousPositions[index];
  return item && position
    ? {
        itemId: item.id,
        viewportOffset: position.top + previousPaddingTop - scrollTop,
      }
    : null;
}

/** Resolve against the old geometry before committing a shorter scroll surface. */
export function getMasonryReflowScrollTop({
  anchor,
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
  const anchoredIndex = anchor ? idToIndexMap.get(anchor.itemId) : undefined;
  const anchoredPosition =
    anchoredIndex === undefined ? undefined : positions[anchoredIndex];
  if (anchor && anchoredPosition) {
    return anchoredPosition.top + nextPaddingTop - anchor.viewportOffset;
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
