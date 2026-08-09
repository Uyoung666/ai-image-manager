import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
} from "react";

// ── 内存日志缓冲区（绕过 Electron console 重定向） ──────────
const MAX_LOG_ENTRIES = 500;
interface ScrollDebugEntry {
  detail?: unknown;
  label: string;
  ts: number;
}

interface ScrollDebugWindow extends Window {
  __inspectScrollPositions?: () => Map<string, ScrollPosition>;
  __scrollLog?: ScrollDebugEntry[];
}

const SCROLL_DEBUG_ENABLED = (() => {
  if (!import.meta.env.DEV || typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem("DEV_SCROLL_DEBUG") === "true";
  } catch {
    return false;
  }
})();

function debugLog(label: string, detail?: unknown) {
  if (!SCROLL_DEBUG_ENABLED) {
    return;
  }
  const entry = { ts: Date.now(), label, detail };
  const debugWindow = window as ScrollDebugWindow;
  const buf = debugWindow.__scrollLog ?? [];
  debugWindow.__scrollLog = buf;
  buf.push(entry);
  if (buf.length > MAX_LOG_ENTRIES) {
    buf.shift();
  }
  try {
    if (detail === undefined) {
      console.warn(`[ScrollCtx] ${label}`);
    } else {
      console.warn(`[ScrollCtx] ${label}`, detail);
    }
  } catch {
    /* ignore */
  }
}

/**
 * 滚动位置锚点：记录可见区域的第一个元素及其偏移量。
 *
 * 内容可寻址设计 —— 同时保存像素偏移和比例偏移：
 * - `offsetFromTop`：精确像素，用于同尺寸窗口的快速恢复
 * - `offsetRatio`：比例如 0~1，用于窗口 resize / detail panel 展开后的鲁棒恢复
 *   计算公式：offsetRatio = offsetFromTop / itemRenderedHeight
 */
export interface ScrollAnchor {
  /** 该 item 在加载数据集中的序号（0-based），用于预加载页码计算 */
  estimatedGlobalIndex?: number;
  /** 可见区域第一个 item 的 ID */
  itemId: number;
  /** 该 item 顶部距离 viewport 顶部的偏移量（px） */
  offsetFromTop: number;
  /** 偏移比例 (0~1)，offsetFromTop / itemHeight，窗口尺寸变化后更鲁棒 */
  offsetRatio: number;
  /** 保存时的时间戳，用于判断是否过期 */
  timestamp: number;
}

/**
 * 完整的滚动位置信息
 * 优先使用 anchor（内容可寻址），fallback 到 scrollTop（像素降级）
 */
export interface ScrollPosition {
  /** 锚点信息（推荐，内容可寻址） */
  anchor?: ScrollAnchor;
  /** 降级像素位置 */
  scrollTop: number;
  /** 保存时的时间戳 */
  timestamp: number;
}

interface ScrollPositionContextValue {
  /**
   * 清除所有滚动位置（如用户手动重置应用状态）
   */
  clearAllScrollPositions: () => void;

  /**
   * 清除指定路由的滚动位置
   * @param routeKey 路由唯一标识
   */
  clearScrollPosition: (routeKey: string) => void;

  /**
   * 强制刷新所有待写入的滚动位置到 sessionStorage
   * 用于 scrollend 事件兜底，确保滚动停止后数据最终持久化
   */
  flushPendingWrites: () => void;

  /**
   * 获取指定路由的滚动位置
   * @param routeKey 路由唯一标识
   * @returns 滚动位置信息，不存在或已过期返回 null
   */
  getScrollPosition: (routeKey: string) => ScrollPosition | null;

  /**
   * 获取指定路由最近一次保存的时间戳（毫秒）
   * 用于防止 cleanup effect 覆盖更近期的 scroll 事件保存
   * @returns 时间戳，未保存过返回 0
   */
  getTimestamp: (routeKey: string) => number;

  /**
   * 标记路由的滚动位置为"脏"状态（如照片删除后）
   * 下次恢复时会跳过锚点恢复，避免定位到已删除的照片
   */
  markRouteDirty: (routeKey: string) => void;
  /**
   * 保存当前路由的滚动位置
   * @param routeKey 路由唯一标识（如 "/" 或 "/albums/123"）
   * @param scrollTop 当前滚动像素位置
   * @param anchor 可选的锚点信息（推荐提供以提高鲁棒性）
   */
  saveScrollPosition: (
    routeKey: string,
    scrollTop: number,
    anchor?: ScrollAnchor
  ) => void;
}

const ScrollPositionContext = createContext<ScrollPositionContextValue | null>(
  null
);

// 位置过期时间：30 分钟（给用户足够时间在不同页面间切换）
const POSITION_EXPIRY_MS = 30 * 60 * 1000;

// 最大缓存路由数量（LRU 策略）
const MAX_CACHED_ROUTES = 30;

function readStoredScrollPosition(routeKey: string): ScrollPosition | null {
  try {
    const stored = sessionStorage.getItem(`scroll_position_${routeKey}`);
    return stored ? (JSON.parse(stored) as ScrollPosition) : null;
  } catch (error) {
    console.debug("[ScrollPositionContext] sessionStorage read failed:", error);
    return null;
  }
}

function routeKeysMatch(routeKey: string, candidateKey: string): boolean {
  return (
    candidateKey.startsWith(`${routeKey}-`) ||
    routeKey.startsWith(`${candidateKey}-`)
  );
}

function findFuzzyMemoryPosition(
  routeKey: string,
  positions: Map<string, ScrollPosition>
): ScrollPosition | null {
  let result: ScrollPosition | null = null;
  for (const [key, position] of positions.entries()) {
    if (
      routeKeysMatch(routeKey, key) &&
      (!result || position.timestamp > result.timestamp)
    ) {
      result = position;
    }
  }
  return result;
}

function findFuzzyStoredPosition(routeKey: string): ScrollPosition | null {
  let result: ScrollPosition | null = null;
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const storageKey = sessionStorage.key(i);
      if (!storageKey?.startsWith("scroll_position_")) {
        continue;
      }
      const storedRouteKey = storageKey.replace("scroll_position_", "");
      if (!routeKeysMatch(routeKey, storedRouteKey)) {
        continue;
      }
      const stored = sessionStorage.getItem(storageKey);
      if (!stored) {
        continue;
      }
      const position = JSON.parse(stored) as ScrollPosition;
      if (!result || position.timestamp > result.timestamp) {
        result = position;
      }
    }
  } catch {
    /* ignore */
  }
  return result;
}

interface ScrollPositionLookup {
  fuzzyMatched: boolean;
  position: ScrollPosition | null;
  source: "memory" | "none" | "sessionStorage";
}

function lookupScrollPosition(
  routeKey: string,
  positions: Map<string, ScrollPosition>
): ScrollPositionLookup {
  let position: ScrollPosition | null = positions.get(routeKey) ?? null;
  let source: ScrollPositionLookup["source"] = position ? "memory" : "none";
  let fuzzyMatched = false;

  if (!position) {
    position = readStoredScrollPosition(routeKey);
    if (position) {
      source = "sessionStorage";
      positions.set(routeKey, position);
    }
  }
  if (!position) {
    position = findFuzzyMemoryPosition(routeKey, positions);
    if (position) {
      source = "memory";
      fuzzyMatched = true;
    }
  }
  if (!position) {
    position = findFuzzyStoredPosition(routeKey);
    if (position) {
      source = "sessionStorage";
      fuzzyMatched = true;
    }
  }
  if (fuzzyMatched && position) {
    positions.set(routeKey, position);
    try {
      sessionStorage.setItem(
        `scroll_position_${routeKey}`,
        JSON.stringify(position)
      );
    } catch {
      /* ignore */
    }
  }

  return { fuzzyMatched, position, source };
}

function removeStoredScrollPosition(routeKey: string): void {
  try {
    sessionStorage.removeItem(`scroll_position_${routeKey}`);
  } catch {
    /* ignore */
  }
}

export function ScrollPositionProvider({ children }: { children: ReactNode }) {
  // 使用 useRef 而非 useState 避免不必要的 re-render
  // 滚动位置是 UI 副作用，不需要触发组件更新
  const positionsRef = useRef<Map<string, ScrollPosition>>(new Map());
  const pendingWritesRef = useRef<Map<string, ScrollPosition>>(new Map());
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // LRU 策略：删除最旧的条目（同时清理 sessionStorage）
  const ensureCacheLimit = useCallback(() => {
    const positions = positionsRef.current;
    if (positions.size >= MAX_CACHED_ROUTES) {
      // 找到最旧的条目
      let oldestKey: string | null = null;
      let oldestTime = Number.POSITIVE_INFINITY;
      for (const [key, pos] of positions.entries()) {
        if (pos.timestamp < oldestTime) {
          oldestTime = pos.timestamp;
          oldestKey = key;
        }
      }
      if (oldestKey) {
        positions.delete(oldestKey);
        pendingWritesRef.current.delete(oldestKey);
        try {
          sessionStorage.removeItem(`scroll_position_${oldestKey}`);
        } catch {
          /* ignore */
        }
      }
    }
  }, []);

  // ── 延迟写入 sessionStorage ──────────────────────────────
  // 每个 scroll 事件都触发保存，但写 sessionStorage 是同步 I/O
  // （~0.5-5ms/次），快速滚动时每秒 60 次会明显卡顿。
  // 解决方案：先写内存 Map（瞬时），然后 debounce 批量写 sessionStorage，
  // 配合 scrollend 事件兜底确保最终一致性。
  const doFlush = useCallback(() => {
    flushTimerRef.current = null;
    const pending = pendingWritesRef.current;
    pendingWritesRef.current = new Map();

    try {
      for (const [routeKey, data] of pending) {
        sessionStorage.setItem(
          `scroll_position_${routeKey}`,
          JSON.stringify(data)
        );
      }
    } catch (err) {
      console.error("[ScrollPositionContext] doFlush failed:", err);
    }
  }, []);

  // 300ms trailing debounce：连续滚动期间只更新内存，停止后再批量持久化。
  // scrollend 和卸载 cleanup 仍会立即 flush，确保最终位置不丢失。
  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
    }
    flushTimerRef.current = setTimeout(doFlush, 300);
  }, [doFlush]);

  const flushPendingWrites = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    doFlush();
  }, [doFlush]);

  const saveScrollPosition = useCallback(
    (routeKey: string, scrollTop: number, anchor?: ScrollAnchor) => {
      if (SCROLL_DEBUG_ENABLED) {
        debugLog("LOG_SAVE", {
          routeKey,
          scrollTop,
          anchorId: anchor?.itemId ?? null,
          anchorOffset: anchor?.offsetFromTop ?? null,
          stack: new Error("scroll-position debug snapshot").stack
            ?.split("\n")
            .slice(2, 4)
            .join(" ← "),
        });
      }

      ensureCacheLimit();

      const data: ScrollPosition = {
        scrollTop,
        anchor,
        timestamp: Date.now(),
      };
      positionsRef.current.set(routeKey, data);

      // 延迟批量写入 sessionStorage，避免滚动时每帧都做同步 I/O
      pendingWritesRef.current.set(routeKey, data);
      scheduleFlush();
    },
    [ensureCacheLimit, scheduleFlush]
  );

  const getScrollPosition = useCallback((routeKey: string) => {
    const lookup = lookupScrollPosition(routeKey, positionsRef.current);
    const { fuzzyMatched, position, source } = lookup;

    debugLog("LOG_READ", {
      routeKey,
      found: !!position,
      source,
      fuzzyMatched,
      scrollTop: position?.scrollTop ?? null,
      anchorId: position?.anchor?.itemId ?? null,
      ageMs: position ? Date.now() - position.timestamp : null,
    });

    if (!position) {
      return null;
    }
    if (Date.now() - position.timestamp > POSITION_EXPIRY_MS) {
      debugLog("LOG_READ_EXPIRED", {
        routeKey,
        ageMs: Date.now() - position.timestamp,
      });
      positionsRef.current.delete(routeKey);
      removeStoredScrollPosition(routeKey);
      return null;
    }

    return position;
  }, []);
  const clearScrollPosition = useCallback((routeKey: string) => {
    positionsRef.current.delete(routeKey);
    pendingWritesRef.current.delete(routeKey);
    if (pendingWritesRef.current.size === 0 && flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    try {
      sessionStorage.removeItem(`scroll_position_${routeKey}`);
    } catch {
      /* ignore */
    }
  }, []);

  const clearAllScrollPositions = useCallback(() => {
    positionsRef.current.clear();
    pendingWritesRef.current.clear();
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    // 清理 sessionStorage 中的所有滚动位置
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key?.startsWith("scroll_position_")) {
          keysToRemove.push(key);
        }
      }
      for (const key of keysToRemove) {
        sessionStorage.removeItem(key);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const markRouteDirty = useCallback((routeKey: string) => {
    // 不清除位置，只标记锚点为 null，下次恢复时走像素 fallback
    const existing = positionsRef.current.get(routeKey);
    if (existing?.anchor) {
      const dirtyPosition = {
        ...existing,
        anchor: undefined,
        timestamp: Date.now(),
      };
      positionsRef.current.set(routeKey, dirtyPosition);
      if (pendingWritesRef.current.has(routeKey)) {
        pendingWritesRef.current.set(routeKey, dirtyPosition);
      }
      try {
        sessionStorage.setItem(
          `scroll_position_${routeKey}`,
          JSON.stringify(dirtyPosition)
        );
      } catch {
        /* ignore */
      }
    }
  }, []);

  const getTimestamp = useCallback((routeKey: string): number => {
    const existing = positionsRef.current.get(routeKey);
    return existing?.timestamp ?? 0;
  }, []);

  const value = useMemo<ScrollPositionContextValue>(
    () => ({
      saveScrollPosition,
      getScrollPosition,
      clearScrollPosition,
      clearAllScrollPositions,
      flushPendingWrites,
      markRouteDirty,
      getTimestamp,
    }),
    [
      saveScrollPosition,
      getScrollPosition,
      clearScrollPosition,
      clearAllScrollPositions,
      flushPendingWrites,
      markRouteDirty,
      getTimestamp,
    ]
  );

  return (
    <ScrollPositionContext.Provider value={value}>
      {children}
    </ScrollPositionContext.Provider>
  );
}

export function useScrollPosition(): ScrollPositionContextValue {
  const ctx = useContext(ScrollPositionContext);
  if (!ctx) {
    throw new Error(
      "useScrollPosition must be used within <ScrollPositionProvider>"
    );
  }
  return ctx;
}

// 开发环境调试工具
if (import.meta.env.DEV) {
  const debugWindow = window as ScrollDebugWindow;
  debugWindow.__inspectScrollPositions = () => {
    const positions = new Map<string, ScrollPosition>();
    // 从 sessionStorage 读取所有位置
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key?.startsWith("scroll_position_")) {
          const routeKey = key.replace("scroll_position_", "");
          const stored = sessionStorage.getItem(key);
          if (stored) {
            const data = JSON.parse(stored) as ScrollPosition;
            positions.set(routeKey, data);
          }
        }
      }
    } catch {
      /* ignore */
    }
    console.table(
      Array.from(positions.entries()).map(([route, pos]) => ({
        route,
        scrollTop: pos.scrollTop,
        hasAnchor: !!pos.anchor,
        anchorItemId: pos.anchor?.itemId,
        ageMinutes: ((Date.now() - pos.timestamp) / 60_000).toFixed(1),
      }))
    );
    return positions;
  };
}
