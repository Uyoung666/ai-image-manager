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
function debugLog(label: string, detail?: unknown) {
  const entry = { ts: Date.now(), label, detail };
  const buf = ((window as any).__scrollLog = (window as any).__scrollLog || []);
  buf.push(entry);
  if (buf.length > MAX_LOG_ENTRIES) {
    buf.shift();
  }
  if (!import.meta.env.DEV) {
    return;
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
interface ScrollAnchor {
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
interface ScrollPosition {
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

export function ScrollPositionProvider({ children }: { children: ReactNode }) {
  // 使用 useRef 而非 useState 避免不必要的 re-render
  // 滚动位置是 UI 副作用，不需要触发组件更新
  const positionsRef = useRef<Map<string, ScrollPosition>>(new Map());

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
  const pendingWritesRef = useRef<Map<string, ScrollPosition>>(new Map());
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFlushRef = useRef(0);

  const doFlush = useCallback(() => {
    flushTimerRef.current = null;
    lastFlushRef.current = Date.now();
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

  // 300ms debounce：短时间内的多次写入合并为一次 batch
  const scheduleFlush = useCallback(() => {
    const now = Date.now();
    const elapsed = now - lastFlushRef.current;

    if (elapsed >= 300) {
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
      }
      doFlush();
    } else if (!flushTimerRef.current) {
      flushTimerRef.current = setTimeout(doFlush, 300 - elapsed);
    }
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
      // ── LOG_SAVE: 每一次写入 sessionStorage 的完整快照 ──
      debugLog("LOG_SAVE", {
        routeKey,
        scrollTop,
        anchorId: anchor?.itemId ?? null,
        anchorOffset: anchor?.offsetFromTop ?? null,
        stack: new Error().stack?.split("\n").slice(2, 4).join(" ← "),
      });

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
    // 优先从内存读取
    let position = positionsRef.current.get(routeKey);
    let source = position ? "memory" : "none";
    let fuzzyMatched = false;

    // Fallback 到 sessionStorage（页面刷新场景）
    if (!position) {
      try {
        const stored = sessionStorage.getItem(`scroll_position_${routeKey}`);
        if (stored) {
          position = JSON.parse(stored) as ScrollPosition;
          source = "sessionStorage";
          positionsRef.current.set(routeKey, position);
        }
      } catch (err) {
        console.debug(
          "[ScrollPositionContext] sessionStorage read failed:",
          err
        );
      }
    }

    // ── 冗余模糊匹配 ──────────────────────────────────────
    // 在卸载期，SidebarFilterContext 的状态可能被重置，导致 Key
    // 末尾多出 "undefined" 等杂质。例如：
    //   保存时: home-all-date-desc
    //   读取时: home-all-undefined-date-desc
    // 此时精确匹配失败，通过前缀搜索找回。
    if (!position) {
      const prefix = routeKey + "-";
      // 搜索内存
      for (const [key, pos] of positionsRef.current.entries()) {
        if (
          (key.startsWith(prefix) || routeKey.startsWith(key + "-")) &&
          (!position || pos.timestamp > position.timestamp)
        ) {
          position = pos;
          source = "memory";
          fuzzyMatched = true;
        }
      }
      // 搜索 sessionStorage
      if (!position) {
        try {
          for (let i = 0; i < sessionStorage.length; i++) {
            const storageKey = sessionStorage.key(i);
            if (!storageKey?.startsWith("scroll_position_")) {
              continue;
            }
            const storedKey = storageKey.replace("scroll_position_", "");
            if (
              storedKey.startsWith(prefix) ||
              routeKey.startsWith(storedKey + "-")
            ) {
              const pos = JSON.parse(
                sessionStorage.getItem(storageKey)!
              ) as ScrollPosition;
              if (!position || pos.timestamp > position.timestamp) {
                position = pos;
                source = "sessionStorage";
                fuzzyMatched = true;
              }
            }
          }
        } catch {
          /* ignore */
        }
      }
      // 将模糊匹配到的数据迁移到精确 Key 下
      if (position) {
        positionsRef.current.set(routeKey, position);
        try {
          sessionStorage.setItem(
            `scroll_position_${routeKey}`,
            JSON.stringify(position)
          );
        } catch {
          /* ignore */
        }
      }
    }

    // ── LOG_READ ───────────────────────────────────────────
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

    // 检查是否过期
    if (Date.now() - position.timestamp > POSITION_EXPIRY_MS) {
      debugLog("LOG_READ_EXPIRED", {
        routeKey,
        ageMs: Date.now() - position.timestamp,
      });
      positionsRef.current.delete(routeKey);
      try {
        sessionStorage.removeItem(`scroll_position_${routeKey}`);
      } catch {
        /* ignore */
      }
      return null;
    }

    return position;
  }, []);

  const clearScrollPosition = useCallback((routeKey: string) => {
    positionsRef.current.delete(routeKey);
    try {
      sessionStorage.removeItem(`scroll_position_${routeKey}`);
    } catch {
      /* ignore */
    }
  }, []);

  const clearAllScrollPositions = useCallback(() => {
    positionsRef.current.clear();
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
    if (existing && existing.anchor) {
      positionsRef.current.set(routeKey, {
        ...existing,
        anchor: undefined,
        timestamp: Date.now(),
      });
      try {
        sessionStorage.setItem(
          `scroll_position_${routeKey}`,
          JSON.stringify({
            ...existing,
            anchor: undefined,
            timestamp: Date.now(),
          })
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
  (window as any).__inspectScrollPositions = () => {
    const positions = new Map<string, ScrollPosition>();
    // 从 sessionStorage 读取所有位置
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key?.startsWith("scroll_position_")) {
          const routeKey = key.replace("scroll_position_", "");
          const data = JSON.parse(sessionStorage.getItem(key)!);
          positions.set(routeKey, data);
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
