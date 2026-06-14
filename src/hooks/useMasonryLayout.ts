import { useMemo, useRef } from "react";

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
}

export interface GroupHeaderInput {
  beforeIndex: number;
  label: string;
}

/**
 * 核心布局计算循环，提取为纯函数以支持增量复用和独立测试。
 *
 * @param initialColumnHeights 可选：增量复用时的起始列高度，
 *   用于无限滚动场景——新增 items 从上次计算的列高度继续放置。
 */
function computeLayout(
  items: Array<{ width: number; height: number }>,
  colWidth: number,
  columnCount: number,
  gap: number,
  groupHeaders: GroupHeaderInput[] | undefined,
  startIndex: number,
  initialColumnHeights?: number[]
): {
  positions: MasonryItem[];
  columnHeights: number[];
  headerPositions: HeaderPosition[];
} {
  const HEADER_HEIGHT = 36;
  const positions: MasonryItem[] = [];
  const columnHeights = initialColumnHeights
    ? [...initialColumnHeights]
    : new Array(columnCount).fill(0);
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
    const globalIdx = startIndex + i;

    if (headerSet.has(globalIdx)) {
      let maxHeight = 0;
      for (let c = 0; c < columnCount; c++) {
        if (columnHeights[c] > maxHeight) {
          maxHeight = columnHeights[c];
        }
      }
      headerPositions.push({
        top: maxHeight,
        label: headerMap.get(globalIdx)!,
      });
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

    positions.push({
      top: columnHeights[shortestCol],
      left: shortestCol * (colWidth + gap),
      width: colWidth,
      height: itemHeight,
    });

    columnHeights[shortestCol] += itemHeight + gap;
  }

  return { positions, columnHeights, headerPositions };
}

export function useMasonryLayout(
  items: Array<{ width: number; height: number }>,
  containerWidth: number,
  columnCount: number,
  gap: number,
  groupHeaders?: GroupHeaderInput[]
): MasonryLayout {
  // 缓存上次计算结果，支持无限滚动时的前缀复用
  const prevRef = useRef<{
    positions: MasonryItem[];
    columnHeights: number[];
    itemCount: number;
    colWidth: number;
    columnCount: number;
    firstItemId: number | null;
  } | null>(null);

  return useMemo(() => {
    if (containerWidth <= 0 || columnCount <= 0 || items.length === 0) {
      prevRef.current = null;
      return { positions: [], totalHeight: 0, headerPositions: [] };
    }

    const colWidth = (containerWidth - (columnCount - 1) * gap) / columnCount;
    const prev = prevRef.current;
    // 校验是否同一数据集：firstItemId 须匹配，防止文件夹切换时错误复用
    const firstItemId = (items[0] as any)?.id ?? null;

    // 判断是否可以前缀复用：列参数未变 + 同一数据集尾部追加（无限滚动）
    const canReuse =
      prev &&
      firstItemId != null &&
      firstItemId === prev.firstItemId &&
      prev.columnCount === columnCount &&
      Math.abs(prev.colWidth - colWidth) < 0.5 &&
      items.length > prev.itemCount &&
      // 有 group header 时不做前缀复用（保守策略：header 位置依赖全局列对齐）
      (!groupHeaders || groupHeaders.length === 0);

    if (canReuse) {
      // 前缀复用：已计算的 positions 不变，传入上次列高度作为起始值，
      // 仅计算新增 items（从 prev.itemCount 索引开始）
      const newItems = items.slice(prev.itemCount);
      const result = computeLayout(
        newItems,
        colWidth,
        columnCount,
        gap,
        undefined, // groupHeaders 已在 canReuse 条件中排除
        prev.itemCount,
        [...prev.columnHeights]
      );
      const positions = [...prev.positions, ...result.positions];
      const headerPositions: HeaderPosition[] = []; // groupHeaders 为 undefined/空

      let totalHeight = 0;
      for (let c = 0; c < columnCount; c++) {
        if (result.columnHeights[c] > totalHeight) {
          totalHeight = result.columnHeights[c];
        }
      }

      prevRef.current = {
        positions,
        columnHeights: result.columnHeights,
        itemCount: items.length,
        colWidth,
        columnCount,
        firstItemId,
      };

      return { positions, totalHeight, headerPositions };
    }

    // 全量重算
    const result = computeLayout(
      items,
      colWidth,
      columnCount,
      gap,
      groupHeaders,
      0
    );

    let totalHeight = 0;
    for (let c = 0; c < columnCount; c++) {
      if (result.columnHeights[c] > totalHeight) {
        totalHeight = result.columnHeights[c];
      }
    }

    prevRef.current = {
      positions: result.positions,
      columnHeights: result.columnHeights,
      itemCount: items.length,
      colWidth,
      columnCount,
      firstItemId,
    };

    return {
      positions: result.positions,
      totalHeight,
      headerPositions: result.headerPositions,
    };
  }, [items, containerWidth, columnCount, gap, groupHeaders]);
}
