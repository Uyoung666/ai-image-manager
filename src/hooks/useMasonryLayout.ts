import { useMemo } from "react";

export interface MasonryItem {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface HeaderPosition {
  top: number;
  label: string;
}

export interface MasonryLayout {
  positions: MasonryItem[];
  totalHeight: number;
  headerPositions: HeaderPosition[];
}

export interface GroupHeaderInput {
  beforeIndex: number;
  label: string;
}

export function useMasonryLayout(
  items: Array<{ width: number; height: number }>,
  containerWidth: number,
  columnCount: number,
  gap: number,
  groupHeaders?: GroupHeaderInput[],
): MasonryLayout {
  const firstW = items.length > 0 ? items[0].width : 0;
  const firstH = items.length > 0 ? items[0].height : 0;
  const lastW = items.length > 0 ? items[items.length - 1].width : 0;
  const lastH = items.length > 0 ? items[items.length - 1].height : 0;
  const headerCount = groupHeaders?.length ?? 0;

  return useMemo(() => {
    if (containerWidth <= 0 || columnCount <= 0 || items.length === 0) {
      return { positions: [], totalHeight: 0, headerPositions: [] };
    }

    const HEADER_HEIGHT = 36;
    const colWidth =
      (containerWidth - (columnCount - 1) * gap) / columnCount;
    const columnHeights = new Array(columnCount).fill(0);
    const positions: MasonryItem[] = new Array(items.length);
    const headerPositions: HeaderPosition[] = [];

    const headerSet = new Set<number>();
    const headerMap = new Map<number, string>();
    if (groupHeaders && groupHeaders.length > 0) {
      for (const h of groupHeaders) {
        headerSet.add(h.beforeIndex);
        headerMap.set(h.beforeIndex, h.label);
      }
    }

    for (let i = 0; i < items.length; i++) {
      if (headerSet.has(i)) {
        // Align all columns to the tallest before inserting header
        let maxHeight = 0;
        for (let c = 0; c < columnCount; c++) {
          if (columnHeights[c] > maxHeight) maxHeight = columnHeights[c];
        }
        headerPositions.push({ top: maxHeight, label: headerMap.get(i)! });
        const newBase = maxHeight + HEADER_HEIGHT + gap;
        for (let c = 0; c < columnCount; c++) {
          columnHeights[c] = newBase;
        }
      }

      const item = items[i];
      const rawAspect =
        item.width && item.height ? item.width / item.height : 4 / 3;
      const aspect = Math.max(0.6, Math.min(rawAspect, 3.0));
      const itemHeight = colWidth / aspect;

      let shortestCol = 0;
      let minHeight = columnHeights[0];
      for (let c = 1; c < columnCount; c++) {
        if (columnHeights[c] < minHeight) {
          minHeight = columnHeights[c];
          shortestCol = c;
        }
      }

      positions[i] = {
        top: columnHeights[shortestCol],
        left: shortestCol * (colWidth + gap),
        width: colWidth,
        height: itemHeight,
      };

      columnHeights[shortestCol] += itemHeight + gap;
    }

    let totalHeight = 0;
    for (let c = 0; c < columnCount; c++) {
      if (columnHeights[c] > totalHeight) {
        totalHeight = columnHeights[c];
      }
    }

    return { positions, totalHeight, headerPositions };
  }, [items.length, containerWidth, columnCount, gap, firstW, firstH, lastW, lastH, headerCount]);
}
