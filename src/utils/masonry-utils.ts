/**
 * 瀑布流布局纯工具函数
 * 从 MasonryGrid 中提取，便于独立测试和复用
 */

/**
 * 二分查找：找到第一个 top + height >= threshold 的位置索引
 * 用于确定当前滚动位置对应的第一个可见元素
 *
 * @param positions - 元素位置数组 [{top, height}, ...]
 * @param threshold - 滚动位置阈值
 * @returns 第一个满足 top + height >= threshold 的索引，
 *          如果所有元素都在阈值以下则返回 positions.length
 */
export function binarySearchStart(
  positions: Array<{ top: number; height: number }>,
  threshold: number
): number {
  let lo = 0;
  let hi = positions.length - 1;
  let result = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (positions[mid].top + positions[mid].height < threshold) {
      lo = mid + 1;
      result = lo;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

/**
 * 为瀑布流位置生成单调递增的“前缀最大底边”索引。
 *
 * 瀑布流按 top 排序，但不同宽高比会让 top + height 不再单调，不能直接
 * 对底边做二分。前缀最大值既保留了 O(log n) 的窗口定位，也不会漏掉
 * 从较早位置延伸到当前视口的长图。
 */
export function buildMasonryVisibilityIndex(
  positions: Array<{ top: number; height: number }>,
  existingIndex: number[] = []
): number[] {
  const index = existingIndex.length > 0 ? [...existingIndex] : [];
  let maxBottom = index.at(-1) ?? Number.NEGATIVE_INFINITY;
  for (const position of positions) {
    maxBottom = Math.max(maxBottom, position.top + position.height);
    index.push(maxBottom);
  }
  return index;
}

/** 返回前缀最大底边首次到达 threshold 的位置。 */
export function binarySearchVisibilityStart(
  visibilityIndex: number[],
  threshold: number
): number {
  let lo = 0;
  let hi = visibilityIndex.length - 1;
  let result = visibilityIndex.length;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (visibilityIndex[mid] >= threshold) {
      result = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return result;
}
