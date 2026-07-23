import { useMemo, useRef } from "react";
import { recordGalleryPerf } from "@/utils/gallery-perf";
import { buildMasonryVisibilityIndex } from "@/utils/masonry-utils";

export interface MasonryItem {
  height: number;
  left: number;
  top: number;
  width: number;
}

export interface HeaderPosition {
  label: string;
  top: number;
}

export interface MasonryLayout {
  headerPositions: HeaderPosition[];
  positions: MasonryItem[];
  totalHeight: number;
  visibilityIndex: number[];
}

export interface GroupHeaderInput {
  beforeIndex: number;
  label: string;
}

export interface MasonryLayoutInput {
  fullWidth?: boolean;
  height: number;
  id: number;
  width: number;
}

interface MasonryLayoutInputSnapshot {
  fullWidth?: boolean;
  height: number;
  id: number;
  width: number;
}

interface MasonryLayoutCache {
  columnCount: number;
  columnHeights: number[];
  colWidth: number;
  groupHeaders: GroupHeaderInput[];
  headerPositions: HeaderPosition[];
  inputSnapshot: MasonryLayoutInputSnapshot[];
  itemCount: number;
  layoutKey: string;
  positions: MasonryItem[];
  visibilityIndex: number[];
}

function snapshotLayoutInputs(
  items: MasonryLayoutInput[]
): MasonryLayoutInputSnapshot[] {
  return items.map(({ fullWidth, height, id, width }) => ({
    fullWidth,
    height,
    id,
    width,
  }));
}

function hasMatchingLayoutPrefix(
  snapshot: MasonryLayoutInputSnapshot[],
  items: MasonryLayoutInput[]
): boolean {
  if (snapshot.length > items.length) {
    return false;
  }
  for (let i = 0; i < snapshot.length; i++) {
    const previous = snapshot[i];
    const current = items[i];
    if (
      previous.id !== current.id ||
      previous.fullWidth !== current.fullWidth ||
      previous.width !== current.width ||
      previous.height !== current.height
    ) {
      return false;
    }
  }
  return true;
}

function hasMatchingHeaderPrefix(
  previousHeaders: GroupHeaderInput[],
  currentHeaders: GroupHeaderInput[] | undefined,
  itemCount: number
): boolean {
  const currentPrefix = (currentHeaders ?? []).filter(
    (header) => header.beforeIndex < itemCount
  );
  if (previousHeaders.length !== currentPrefix.length) {
    return false;
  }
  return previousHeaders.every(
    (header, index) =>
      header.beforeIndex === currentPrefix[index].beforeIndex &&
      header.label === currentPrefix[index].label
  );
}

/** Core masonry calculation. `groupHeaders` always use global item indexes. */
function computeLayout(
  items: Array<{ fullWidth?: boolean; width: number; height: number }>,
  colWidth: number,
  columnCount: number,
  gap: number,
  groupHeaders: GroupHeaderInput[] | undefined,
  startIndex: number,
  initialColumnHeights?: number[],
  existingHeaders?: HeaderPosition[],
  existingVisibilityIndex?: number[]
): {
  positions: MasonryItem[];
  columnHeights: number[];
  headerPositions: HeaderPosition[];
  visibilityIndex: number[];
} {
  const headerHeight = 36;
  const positions: MasonryItem[] = [];
  const columnHeights = initialColumnHeights
    ? [...initialColumnHeights]
    : new Array(columnCount).fill(0);
  const headerPositions: HeaderPosition[] = [];
  const headerMap = new Map(
    (groupHeaders ?? []).map((header) => [header.beforeIndex, header.label])
  );

  for (let i = 0; i < items.length; i++) {
    const globalIndex = startIndex + i;
    const headerLabel = headerMap.get(globalIndex);
    if (headerLabel !== undefined) {
      const maxHeight = Math.max(...columnHeights);
      headerPositions.push({ label: headerLabel, top: maxHeight });
      const newBase = maxHeight + headerHeight + gap;
      columnHeights.fill(newBase);
    }

    const item = items[i];
    if (item.fullWidth) {
      const top = Math.max(...columnHeights);
      const width = colWidth * columnCount + gap * (columnCount - 1);
      positions.push({
        height: item.height,
        left: 0,
        top,
        width,
      });
      columnHeights.fill(top + item.height + gap);
      continue;
    }
    const rawAspect =
      item.width && item.height ? item.width / item.height : 4 / 3;
    const aspect = Math.max(0.6, Math.min(rawAspect, 3));
    const itemHeight = colWidth / aspect;

    let shortestColumn = 0;
    for (let column = 1; column < columnCount; column++) {
      if (columnHeights[column] < columnHeights[shortestColumn]) {
        shortestColumn = column;
      }
    }

    positions.push({
      height: itemHeight,
      left: shortestColumn * (colWidth + gap),
      top: columnHeights[shortestColumn],
      width: colWidth,
    });
    columnHeights[shortestColumn] += itemHeight + gap;
  }

  return {
    positions,
    columnHeights,
    headerPositions: existingHeaders
      ? [...existingHeaders, ...headerPositions]
      : headerPositions,
    visibilityIndex: buildMasonryVisibilityIndex(
      positions,
      existingVisibilityIndex
    ),
  };
}

function getTotalHeight(columnHeights: number[]): number {
  return columnHeights.length > 0 ? Math.max(...columnHeights) : 0;
}

function createCache(
  items: MasonryLayoutInput[],
  groupHeaders: GroupHeaderInput[] | undefined,
  layoutKey: string,
  colWidth: number,
  columnCount: number,
  result: {
    positions: MasonryItem[];
    columnHeights: number[];
    headerPositions: HeaderPosition[];
    visibilityIndex: number[];
  }
): MasonryLayoutCache {
  return {
    colWidth,
    columnCount,
    columnHeights: result.columnHeights,
    groupHeaders: (groupHeaders ?? []).map((header) => ({ ...header })),
    headerPositions: result.headerPositions,
    inputSnapshot: snapshotLayoutInputs(items),
    itemCount: items.length,
    layoutKey,
    positions: result.positions,
    visibilityIndex: result.visibilityIndex,
  };
}

export function useMasonryLayout(
  items: MasonryLayoutInput[],
  containerWidth: number,
  columnCount: number,
  gap: number,
  groupHeaders?: GroupHeaderInput[],
  layoutKey = "default"
): MasonryLayout {
  const previousRef = useRef<MasonryLayoutCache | null>(null);

  return useMemo(() => {
    const start = performance.now();
    if (containerWidth <= 0 || columnCount <= 0 || items.length === 0) {
      previousRef.current = null;
      recordGalleryPerf("masonryLayoutMs", performance.now() - start);
      return {
        headerPositions: [],
        positions: [],
        totalHeight: 0,
        visibilityIndex: [],
      };
    }

    const colWidth = (containerWidth - (columnCount - 1) * gap) / columnCount;
    const previous = previousRef.current;
    const canReuse =
      previous !== null &&
      layoutKey === previous.layoutKey &&
      previous.columnCount === columnCount &&
      Math.abs(previous.colWidth - colWidth) < 0.5 &&
      items.length > previous.itemCount &&
      hasMatchingLayoutPrefix(previous.inputSnapshot, items) &&
      hasMatchingHeaderPrefix(
        previous.groupHeaders,
        groupHeaders,
        previous.itemCount
      );

    if (canReuse) {
      const appendedHeaders = groupHeaders?.filter(
        (header) =>
          header.beforeIndex >= previous.itemCount &&
          header.beforeIndex < items.length
      );
      const appended = computeLayout(
        items.slice(previous.itemCount),
        colWidth,
        columnCount,
        gap,
        appendedHeaders,
        previous.itemCount,
        previous.columnHeights,
        previous.headerPositions,
        previous.visibilityIndex
      );
      const result = {
        ...appended,
        positions: [...previous.positions, ...appended.positions],
      };
      previousRef.current = createCache(
        items,
        groupHeaders,
        layoutKey,
        colWidth,
        columnCount,
        result
      );
      const layout = {
        headerPositions: result.headerPositions,
        positions: result.positions,
        totalHeight: getTotalHeight(result.columnHeights),
        visibilityIndex: result.visibilityIndex,
      };
      recordGalleryPerf("masonryLayoutMs", performance.now() - start);
      return layout;
    }

    const result = computeLayout(
      items,
      colWidth,
      columnCount,
      gap,
      groupHeaders,
      0
    );
    previousRef.current = createCache(
      items,
      groupHeaders,
      layoutKey,
      colWidth,
      columnCount,
      result
    );
    const layout = {
      headerPositions: result.headerPositions,
      positions: result.positions,
      totalHeight: getTotalHeight(result.columnHeights),
      visibilityIndex: result.visibilityIndex,
    };
    recordGalleryPerf("masonryLayoutMs", performance.now() - start);
    return layout;
  }, [items, containerWidth, columnCount, gap, groupHeaders, layoutKey]);
}
