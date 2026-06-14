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
    const mid = (lo + hi) >>> 1;
    if (positions[mid].top + positions[mid].height < threshold) {
      lo = mid + 1;
      result = lo;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}
