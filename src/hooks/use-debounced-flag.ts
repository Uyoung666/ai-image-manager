import { useEffect, useState } from "react";

/**
 * 布尔值防抖 Hook。
 *
 * 行为：
 * - 输入变为 true 时，延迟 delay 毫秒后才输出 true。
 * - 输入变为 false 时，立即输出 false 并清除等待中的定时器。
 * - delay 变化时，若当前 value 为 true，定时器会重置。
 *
 * 典型用途：防止短暂的状态切换（如 < 150ms 的 loading）导致
 * Spinner 挂载/卸载产生视觉频闪。
 */
export function useDebouncedFlag(value: boolean, delay: number): boolean {
  const [debounced, setDebounced] = useState(false);

  useEffect(() => {
    if (!value) {
      setDebounced(false);
      return;
    }
    const timer = setTimeout(() => setDebounced(true), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
