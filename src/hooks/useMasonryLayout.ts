import { useMemo } from "react";

export interface MasonryItem {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface MasonryLayout {
  positions: MasonryItem[];
  totalHeight: number;
}

export function useMasonryLayout(
  items: Array<{ width: number; height: number }>,
  containerWidth: number,
  columnCount: number,
  gap: number,
): MasonryLayout {
  const firstW = items.length > 0 ? items[0].width : 0;
  const firstH = items.length > 0 ? items[0].height : 0;
  const lastW = items.length > 0 ? items[items.length - 1].width : 0;
  const lastH = items.length > 0 ? items[items.length - 1].height : 0;

  return useMemo(() => {
    if (containerWidth <= 0 || columnCount <= 0 || items.length === 0) {
      return { positions: [], totalHeight: 0 };
    }

    const colWidth =
      (containerWidth - (columnCount - 1) * gap) / columnCount;
    const columnHeights = new Array(columnCount).fill(0);
    const positions: MasonryItem[] = new Array(items.length);

    for (let i = 0; i < items.length; i++) {
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

    return { positions, totalHeight };
  }, [items.length, containerWidth, columnCount, gap, firstW, firstH, lastW, lastH]);
}
