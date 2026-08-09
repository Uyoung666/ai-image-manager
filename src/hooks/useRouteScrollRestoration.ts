import { useLocation } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import {
  type ScrollPosition,
  useScrollPosition,
} from "@/contexts/ScrollPositionContext";

// ── 内存日志缓冲区 ──────────────────────────────────────────
const MAX_LOG_ENTRIES = 500;
interface ScrollDebugEntry {
  detail?: unknown;
  label: string;
  ts: number;
}

interface ScrollDebugWindow extends Window {
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
      console.warn(`[ScrollRestore] ${label}`);
    } else {
      console.warn(`[ScrollRestore] ${label}`, detail);
    }
  } catch {
    /* ignore */
  }
}

/** 几何坍塌检测阈值：scrollHeight 断崖式下跌超过此值即判定为卸载期坍塌 */
const COLLAPSE_THRESHOLD_PX = 500;

/** 全局挂载实例计数器：每次 useRouteScrollRestoration 挂载时 +1，用于日志追踪 */
let globalInstanceCounter = 0;

interface PendingRestore {
  anchorId?: number;
  offsetFromTop?: number;
  offsetRatio?: number;
  targetScrollTop: number;
}

interface RestoreGridHandle {
  cancelEnforceLock(): void;
  getCurrentAnchor(): {
    estimatedGlobalIndex?: number;
    itemId: number;
    offsetFromTop: number;
    offsetRatio: number;
  } | null;
  readonly scrollElement: HTMLDivElement | null;
  scrollToItem(itemId: number, offsetRatio: number): void;
  scrollToPixel(scrollTop: number): void;
}

interface RestoreRefs {
  hasInitialPositionedRef: { current: boolean };
  hasRestoredRef: { current: boolean };
  isRestoringRef: { current: boolean };
  lastLoadMoreItemCountRef: { current: number };
  lastRestoredItemCountRef: { current: number };
  pendingRestoreRef: { current: PendingRestore | null };
}

interface RestoreTarget {
  anchorId?: number;
  mode: "anchor" | "pixel";
  offsetFromTop?: number;
  offsetRatio?: number;
  targetScrollTop: number;
}

interface AppliedRestore {
  anchorId?: number;
  anchorOffset?: number;
  scrollTop: number;
}

interface RestoreContext {
  cancelUnlockTimer: () => void;
  debug: (label: string, detail?: unknown) => void;
  el: HTMLElement;
  gridRef?: React.RefObject<RestoreGridHandle | null>;
  hasMore: boolean;
  itemCount: number;
  lastLoadMoreItemCountRef: { current: number };
  logId: (label: string, detail?: unknown) => void;
  notifyRestoreSettled: () => void;
  onLoadMore?: () => void;
  refs: RestoreRefs;
  resolvePixelOffset: (
    itemId: number,
    offsetFromTop: number,
    offsetRatio: number
  ) => number;
  restoreFromAnchor?: (anchorItemId: number) => number | null;
  routeKey: string;
  scheduleForcedUnlock: (
    anchorItemId?: number,
    anchorOffset?: number,
    anchorOffsetRatio?: number
  ) => void;
  scheduleUnlock: () => void;
  scrollPosition: {
    getScrollPosition: (routeKey: string) => ScrollPosition | null;
  };
  seedSnapshotAfterRestore: (
    scrollTop: number,
    scrollHeight: number,
    anchorItemId?: number,
    anchorOffset?: number,
    anchorOffsetRatio?: number,
    estimatedGlobalIndex?: number
  ) => void;
}

function getInitialRestoreTarget(
  saved: ScrollPosition,
  el: HTMLElement,
  restoreFromAnchor?: (anchorItemId: number) => number | null
): RestoreTarget | PendingRestore | null {
  if (saved.anchor && restoreFromAnchor) {
    const targetScrollTop = restoreFromAnchor(saved.anchor.itemId);
    if (targetScrollTop === null) {
      return {
        anchorId: saved.anchor.itemId,
        offsetFromTop: saved.anchor.offsetFromTop,
        offsetRatio: saved.anchor.offsetRatio ?? 0,
        targetScrollTop: saved.scrollTop,
      };
    }
    return {
      anchorId: saved.anchor.itemId,
      mode: "anchor",
      offsetFromTop: saved.anchor.offsetFromTop,
      offsetRatio: saved.anchor.offsetRatio ?? 0,
      targetScrollTop,
    };
  }

  if (saved.scrollTop > 0) {
    if (saved.scrollTop > el.scrollHeight) {
      return { targetScrollTop: saved.scrollTop };
    }
    return {
      mode: "pixel",
      targetScrollTop: Math.min(
        saved.scrollTop,
        el.scrollHeight - el.clientHeight
      ),
    };
  }
  return null;
}

function getPendingRestoreTarget(
  pending: PendingRestore,
  el: HTMLElement,
  restoreFromAnchor: RestoreContext["restoreFromAnchor"]
): RestoreTarget | null {
  if (pending.anchorId !== undefined && restoreFromAnchor) {
    const targetScrollTop = restoreFromAnchor(pending.anchorId);
    if (targetScrollTop !== null) {
      return {
        anchorId: pending.anchorId,
        mode: "anchor",
        offsetFromTop: pending.offsetFromTop,
        offsetRatio: pending.offsetRatio ?? 0,
        targetScrollTop,
      };
    }
  }

  if (
    pending.targetScrollTop > 0 &&
    el.scrollHeight >= pending.targetScrollTop
  ) {
    return { mode: "pixel", targetScrollTop: pending.targetScrollTop };
  }
  return null;
}

function applyRestoreTarget(
  context: RestoreContext,
  target: RestoreTarget
): AppliedRestore {
  if (target.mode === "anchor" && target.anchorId !== undefined) {
    if (context.gridRef?.current?.scrollToItem) {
      context.gridRef.current.scrollToItem(
        target.anchorId,
        target.offsetRatio ?? 0
      );
      context.scheduleForcedUnlock(
        target.anchorId,
        target.offsetFromTop,
        target.offsetRatio
      );
    } else {
      const pixelOffset = context.resolvePixelOffset(
        target.anchorId,
        target.offsetFromTop ?? 0,
        target.offsetRatio ?? 0
      );
      context.el.scrollTop = Math.max(0, target.targetScrollTop + pixelOffset);
    }
    return {
      anchorId: target.anchorId,
      anchorOffset: target.offsetFromTop ?? 0,
      scrollTop: context.el.scrollTop,
    };
  }

  if (context.gridRef?.current?.scrollToPixel) {
    context.gridRef.current.scrollToPixel(target.targetScrollTop);
  } else {
    const maxScroll = context.el.scrollHeight - context.el.clientHeight;
    context.el.scrollTop = Math.min(target.targetScrollTop, maxScroll);
  }
  return { scrollTop: context.el.scrollTop };
}

function completeRestore(
  context: RestoreContext,
  scrollTop: number,
  anchorId?: number,
  anchorOffset?: number
): void {
  context.refs.hasRestoredRef.current = true;
  context.refs.hasInitialPositionedRef.current = true;
  context.refs.lastRestoredItemCountRef.current = context.itemCount;
  context.seedSnapshotAfterRestore(
    scrollTop,
    context.el.scrollHeight,
    anchorId,
    anchorOffset
  );
  context.notifyRestoreSettled();
  context.scheduleUnlock();
}

function processPendingRestore(context: RestoreContext): boolean {
  const pending = context.refs.pendingRestoreRef.current;
  if (!pending) {
    return false;
  }

  context.debug("restore: PENDING retry", {
    anchorId: pending.anchorId,
    targetScrollTop: pending.targetScrollTop,
    itemCount: context.itemCount,
    hasMore: context.hasMore,
  });
  const target = getPendingRestoreTarget(
    pending,
    context.el,
    context.restoreFromAnchor
  );
  if (target) {
    context.cancelUnlockTimer();
    context.refs.isRestoringRef.current = true;
    const applied = applyRestoreTarget(context, target);
    context.refs.pendingRestoreRef.current = null;
    context.refs.lastLoadMoreItemCountRef.current = 0;
    completeRestore(
      context,
      applied.scrollTop,
      applied.anchorId,
      applied.anchorOffset
    );
    context.logId("LOG_RESTORE", {
      routeKey: context.routeKey,
      result: "pending_resolved",
      scrollTop: context.el.scrollTop,
      scrollHeight: context.el.scrollHeight,
      anchorId: applied.anchorId,
      hasPending: false,
    });
    return true;
  }

  if (
    context.onLoadMore &&
    context.hasMore &&
    context.itemCount !== context.lastLoadMoreItemCountRef.current
  ) {
    context.lastLoadMoreItemCountRef.current = context.itemCount;
    context.debug("pending: calling onLoadMore()", {
      itemCount: context.itemCount,
    });
    context.onLoadMore();
  }
  return true;
}

function processSavedRestore(
  context: RestoreContext,
  saved: ScrollPosition
): boolean {
  const target = getInitialRestoreTarget(
    saved,
    context.el,
    context.restoreFromAnchor
  );
  if (!target) {
    return false;
  }

  if (!("mode" in target)) {
    if (!context.hasMore) {
      const bestAvailableScrollTop = Math.max(
        0,
        Math.min(
          target.targetScrollTop,
          context.el.scrollHeight - context.el.clientHeight
        )
      );
      const applied = applyRestoreTarget(context, {
        mode: "pixel",
        targetScrollTop: bestAvailableScrollTop,
      });
      context.refs.pendingRestoreRef.current = null;
      completeRestore(context, applied.scrollTop);
      return true;
    }

    context.refs.pendingRestoreRef.current = target;
    context.refs.hasRestoredRef.current = true;
    context.refs.hasInitialPositionedRef.current = true;
    context.refs.lastRestoredItemCountRef.current = context.itemCount;
    context.logId("LOG_RESTORE", {
      routeKey: context.routeKey,
      result: "pending",
      targetScrollTop: target.targetScrollTop,
      anchorId: target.anchorId,
      hasPending: true,
    });
    if (context.onLoadMore && context.hasMore) {
      context.lastLoadMoreItemCountRef.current = context.itemCount;
      context.debug("pending: initial onLoadMore() call", {
        itemCount: context.itemCount,
      });
      context.onLoadMore();
    }
    return true;
  }

  const applied = applyRestoreTarget(context, target);
  completeRestore(
    context,
    applied.scrollTop,
    applied.anchorId,
    applied.anchorOffset
  );
  context.logId("LOG_RESTORE", {
    routeKey: context.routeKey,
    result: "restored",
    scrollTop: context.el.scrollTop,
    scrollHeight: context.el.scrollHeight,
    anchorId: applied.anchorId,
    hasPending: false,
  });
  return true;
}

function runRestoreEffect(
  context: RestoreContext,
  restoreReady: boolean,
  isPlaceholderData: boolean
): void {
  if (isPlaceholderData) {
    context.debug("restore: BLOCKED (isPlaceholderData)");
    return;
  }
  if (!restoreReady) {
    context.debug("restore: BLOCKED (restoreReady=false)");
    return;
  }
  if (processPendingRestore(context)) {
    return;
  }

  if (context.refs.hasRestoredRef.current) {
    const itemCountGrew =
      context.itemCount > context.refs.lastRestoredItemCountRef.current;
    if (itemCountGrew && context.refs.pendingRestoreRef.current) {
      context.debug("restore: RETRY (itemCount grew, pending active)", {
        prev: context.refs.lastRestoredItemCountRef.current,
        now: context.itemCount,
      });
      context.refs.hasRestoredRef.current = false;
    } else {
      return;
    }
  }

  context.cancelUnlockTimer();
  context.refs.isRestoringRef.current = true;
  const saved = context.scrollPosition.getScrollPosition(context.routeKey);
  context.logId("LOG_RESTORE", {
    routeKey: context.routeKey,
    hasSaved: !!saved,
    savedScrollTop: saved?.scrollTop ?? null,
    savedAnchorId: saved?.anchor?.itemId ?? null,
    scrollHeight: context.el.scrollHeight,
    clientHeight: context.el.clientHeight,
    itemCount: context.itemCount,
    isPending: false,
    phase: "priority1",
  });

  if (saved && processSavedRestore(context, saved)) {
    return;
  }
  if (!saved) {
    context.logId("LOG_RESTORE", {
      routeKey: context.routeKey,
      result: "no_saved_position",
      hasSaved: false,
      hasPending: false,
    });
  }

  context.refs.hasRestoredRef.current = true;
  context.refs.hasInitialPositionedRef.current = true;
  context.refs.lastRestoredItemCountRef.current = context.itemCount;
  context.logId("LOG_RESTORE", {
    routeKey: context.routeKey,
    result: "fallthrough_unlock",
    hasPending: false,
  });
  context.notifyRestoreSettled();
  context.scheduleUnlock();
}

/**
 * 为当前路由自动管理滚动位置的保存和恢复。
 *
 * 三层防御体系：
 * 1. 路由级导航冻结（useLayoutEffect cleanup）— 卸载前封门
 * 2. 几何坍塌冻结（scrollHeight 断崖检测）— DOM 级双重保险
 * 3. 用户绝对主权（forceUnlock + 用户介入事件）— 防止死锁
 *
 * @returns forceUnlock — 用户介入时立刻砸碎所有锁
 */
interface ScrollFrameAnchor {
  estimatedGlobalIndex?: number;
  itemId: number;
  offsetFromTop: number;
  offsetRatio: number;
}

interface ScrollFrameState {
  anchor: ScrollFrameAnchor | null;
  scrollHeight: number;
  scrollTop: number;
}

interface ScrollFrameContext {
  debug: (label: string, detail?: unknown) => void;
  el: HTMLElement;
  getCurrentAnchor: () => ScrollFrameAnchor | null | undefined;
  isNavigatingAwayRef: { current: boolean };
  isRestoringRef: { current: boolean };
  lastKnownGoodStateRef: { current: ScrollFrameState | null };
  lastSaveRouteKeyRef: { current: string };
  pendingRestoreRef: { current: PendingRestore | null };
  routeKey: string;
  saveScrollPosition: (
    routeKey: string,
    scrollTop: number,
    anchor?: ScrollFrameAnchor & { timestamp: number }
  ) => void;
}

function saveScrollFrame(context: ScrollFrameContext): void {
  if (context.isNavigatingAwayRef.current) {
    context.debug("RAF save: BLOCKED (navigating away in RAF)");
    return;
  }
  if (!context.el.isConnected) {
    context.debug("RAF save: SKIPPED (disconnected)");
    return;
  }
  if (context.isRestoringRef.current || context.pendingRestoreRef.current) {
    context.debug("RAF save: BLOCKED (RAF)");
    return;
  }

  const scrollTop = context.el.scrollTop;
  const anchor = context.getCurrentAnchor();
  context.lastKnownGoodStateRef.current = {
    scrollTop,
    scrollHeight: context.el.scrollHeight,
    anchor: anchor
      ? {
          itemId: anchor.itemId,
          offsetFromTop: anchor.offsetFromTop,
          offsetRatio: anchor.offsetRatio,
          estimatedGlobalIndex: anchor.estimatedGlobalIndex,
        }
      : null,
  };
  context.lastSaveRouteKeyRef.current = context.routeKey;

  if (SCROLL_DEBUG_ENABLED) {
    context.debug("RAF save: executing", {
      routeKey: context.routeKey,
      scrollTop,
      anchorId: anchor?.itemId ?? null,
      offsetRatio: anchor?.offsetRatio,
    });
  }
  context.saveScrollPosition(
    context.routeKey,
    scrollTop,
    anchor
      ? {
          itemId: anchor.itemId,
          offsetFromTop: anchor.offsetFromTop,
          offsetRatio: anchor.offsetRatio,
          estimatedGlobalIndex: anchor.estimatedGlobalIndex,
          timestamp: Date.now(),
        }
      : undefined
  );
}

export function useRouteScrollRestoration(
  scrollRef: React.RefObject<HTMLElement | null>,
  options?: {
    getRouteKey?: () => string;
    getCurrentAnchor?: () => {
      itemId: number;
      offsetFromTop: number;
      offsetRatio: number;
      estimatedGlobalIndex?: number;
    } | null;
    restoreFromAnchor?: (anchorItemId: number) => number | null;
    restoreReady?: boolean;
    itemCount?: number;
    isPlaceholderData?: boolean;
    onLoadMore?: () => void;
    hasMore?: boolean;
    onRestoreSettled?: (routeKey: string) => void;
    /** MasonryGrid 的命令式 ref，用于原子定位（scrollToItem）与锁解除 */
    gridRef?: React.RefObject<{
      scrollToItem: (itemId: number, offsetRatio: number) => void;
      scrollToPixel: (scrollTop: number) => void;
      cancelEnforceLock(): void;
      getCurrentAnchor(): {
        itemId: number;
        offsetFromTop: number;
        offsetRatio: number;
        estimatedGlobalIndex?: number;
      } | null;
      readonly scrollElement: HTMLDivElement | null;
    } | null>;
  }
): {
  initialScrollTop: number;
  hasInitialPositionedRef: React.RefObject<boolean>;
  forceUnlock: () => void;
} {
  const location = useLocation();
  const scrollPosition = useScrollPosition();

  const getRouteKey = options?.getRouteKey || (() => location.pathname);
  const routeKey = getRouteKey();

  // ── 实例 ID：每次挂载 +1，用于全生命周期日志追踪 ──────────
  const instanceIdRef = useRef(0);
  if (instanceIdRef.current === 0) {
    instanceIdRef.current = ++globalInstanceCounter;
  }
  const iid = instanceIdRef.current;
  const logId = useCallback(
    (label: string, detail?: unknown) => {
      debugLog(label, { iid, ...((detail as object) || {}) });
    },
    [iid]
  );

  const hasRestoredRef = useRef(false);
  const hasInitialPositionedRef = useRef(false);
  const lastRestoredItemCountRef = useRef(0);
  const isRestoringRef = useRef(true);
  const pendingRestoreRef = useRef<PendingRestore | null>(null);
  const lastLoadMoreItemCountRef = useRef(0);

  /**
   * 恢复锁超时计时器 ID。
   * 托管 300ms 延时解锁，替代原来的双重 RAF（~32ms）。
   * 300ms 是 ResizeObserver 回稳 + TanStack Query 渲染完成的保守窗口。
   */
  const restoreLockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  const cancelUnlockTimer = useCallback(() => {
    if (restoreLockTimerRef.current !== null) {
      clearTimeout(restoreLockTimerRef.current);
      restoreLockTimerRef.current = null;
    }
  }, []);

  /**
   * 从锚点数据计算当前布局下的像素偏移。
   * 优先使用 offsetRatio（内容可寻址，免疫窗口 resize），
   * fallback 到 offsetFromTop（精确像素）。
   */
  const resolvePixelOffset = useCallback(
    (itemId: number, offsetFromTop: number, offsetRatio: number): number => {
      if (offsetRatio > 0) {
        const el = scrollRef.current;
        if (el) {
          const card = el.querySelector(
            `[data-photo-id="${itemId}"]`
          ) as HTMLElement | null;
          if (card && card.offsetHeight > 0) {
            return offsetRatio * card.offsetHeight;
          }
        }
      }
      return offsetFromTop;
    },
    [scrollRef]
  );

  /** 标记强制解锁是否已调度——防止 scheduleUnlock 覆盖 850ms 定时器 */
  const forcedUnlockScheduledRef = useRef(false);

  /** 托管解锁：300ms 后释放 isRestoringRef（常规路径）。
   *  如果强制解锁已调度则跳过，防止覆盖 850ms 定时器。 */
  const scheduleUnlock = useCallback(() => {
    if (forcedUnlockScheduledRef.current) {
      return;
    }
    cancelUnlockTimer();
    restoreLockTimerRef.current = setTimeout(() => {
      restoreLockTimerRef.current = null;
      pendingRestoreRef.current = null;
      isRestoringRef.current = false;
      logId("UNLOCK: isRestoringRef released after 300ms");
    }, 300);
  }, [cancelUnlockTimer, logId]);

  /**
   * 最后已知良好快照。
   * 只在 scroll 事件的 RAF 回调中更新（所有锁+冻结检查通过后）。
   */
  const lastKnownGoodStateRef = useRef<{
    scrollTop: number;
    scrollHeight: number;
    anchor: {
      itemId: number;
      offsetFromTop: number;
      offsetRatio: number;
      estimatedGlobalIndex?: number;
    } | null;
  } | null>(null);

  // ═══════════════════════════════════════════════════════════
  // 防御层 1：路由级导航冻结
  // ═══════════════════════════════════════════════════════════
  // useLayoutEffect cleanup 在 React 移除 DOM 节点之前同步执行。
  // 置此标志后，卸载期 DOM 坍塌产生的幽灵 scroll 事件会被拦截。
  const isNavigatingAwayRef = useRef(false);
  useLayoutEffect(() => {
    // 挂载/重挂载时复位（理论上不会走到这里，但防御性编码）
    isNavigatingAwayRef.current = false;
    return () => {
      isNavigatingAwayRef.current = true;
      debugLog(
        "NAV FREEZE: locked — blocking all scroll events during unmount"
      );
    };
  }, []);

  /**
   * 固化路由 Key：始终记录最后一次写入操作使用的 routeKey。
   * cleanup 函数严格使用此 Key 而非闭包中的 routeKey，
   * 防止卸载期渲染产生的不一致 Key 导致缓存 Miss。
   */
  const lastSaveRouteKeyRef = useRef(routeKey);

  const getCurrentAnchor = options?.getCurrentAnchor;
  const restoreFromAnchor = options?.restoreFromAnchor;
  const gridRef = options?.gridRef;
  const restoreReady = options?.restoreReady ?? false;
  const isPlaceholderData = options?.isPlaceholderData ?? false;
  const itemCount = options?.itemCount ?? 0;
  const onLoadMore = options?.onLoadMore;
  const hasMore = options?.hasMore ?? false;
  const onRestoreSettledRef = useRef(options?.onRestoreSettled);
  onRestoreSettledRef.current = options?.onRestoreSettled;
  const settledRouteKeyRef = useRef<string | null>(null);
  const notifyRestoreSettled = useCallback(() => {
    if (settledRouteKeyRef.current === routeKey) {
      return;
    }
    settledRouteKeyRef.current = routeKey;
    onRestoreSettledRef.current?.(routeKey);
  }, [routeKey]);

  // ── 种子函数：将恢复成功后的位置写入快照 ──────────────────
  useEffect(() => {
    logId("MOUNTED", {
      routeKey,
      restoreReady,
      isPlaceholder: isPlaceholderData,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaceholderData, restoreReady, logId, routeKey]);

  const seedSnapshotAfterRestore = useCallback(
    (
      scrollTop: number,
      scrollHeight: number,
      anchorItemId?: number,
      anchorOffset?: number,
      anchorOffsetRatio?: number,
      estimatedGlobalIndex?: number
    ) => {
      lastKnownGoodStateRef.current = {
        scrollTop,
        scrollHeight,
        anchor:
          anchorItemId === undefined
            ? null
            : {
                itemId: anchorItemId,
                offsetFromTop: anchorOffset ?? 0,
                offsetRatio: anchorOffsetRatio ?? 0,
                estimatedGlobalIndex,
              },
      };
    },
    []
  );

  /**
   * 强制解锁 + 种子快照：850ms 后释放所有锁（留 50ms 余量给蛮牛锁 800ms），
   * 并立即抓取当前位置写入快照——防止解锁瞬间因缺快照导致后续保存链断裂。
   * 专用于 gridRef.scrollToItem 原子定位路径。
   */
  const scheduleForcedUnlock = useCallback(
    (
      anchorItemId?: number,
      anchorOffset?: number,
      anchorOffsetRatio?: number
    ) => {
      forcedUnlockScheduledRef.current = true;
      cancelUnlockTimer();
      pendingRestoreRef.current = null;
      restoreLockTimerRef.current = setTimeout(() => {
        restoreLockTimerRef.current = null;
        forcedUnlockScheduledRef.current = false;

        const releaseAllLocks = () => {
          isRestoringRef.current = false;
          pendingRestoreRef.current = null;
        };

        if (isNavigatingAwayRef.current) {
          logId("FORCED UNLOCK: BLOCKED (navigating away)");
          releaseAllLocks();
          return;
        }
        const el = scrollRef.current;
        if (!el?.isConnected) {
          logId("FORCED UNLOCK: BLOCKED (disconnected)");
          releaseAllLocks();
          return;
        }

        releaseAllLocks();

        seedSnapshotAfterRestore(
          el.scrollTop,
          el.scrollHeight,
          anchorItemId,
          anchorOffset,
          anchorOffsetRatio
        );
        logId("FORCED UNLOCK: all locks released after 850ms");
      }, 850);
    },
    [cancelUnlockTimer, logId, scrollRef, seedSnapshotAfterRestore]
  );

  // ── 用户绝对主权：强制解锁所有锁 ──────────────────────────
  const forceUnlock = useCallback(() => {
    cancelUnlockTimer();
    gridRef?.current?.cancelEnforceLock();
    if (isRestoringRef.current || pendingRestoreRef.current) {
      logId("USER OVERRIDE: force-unlocking all locks", {
        wasRestoring: isRestoringRef.current,
        hadPending: !!pendingRestoreRef.current,
      });
      isRestoringRef.current = false;
      pendingRestoreRef.current = null;
    }
  }, [cancelUnlockTimer, logId, gridRef]);

  // ── Render 阶段预读 ────────────────────────────────────────
  const initialScrollTop = useMemo(() => {
    const saved = scrollPosition.getScrollPosition(routeKey);
    if (!saved) {
      return 0;
    }
    if (saved.anchor && restoreFromAnchor) {
      const targetScrollTop = restoreFromAnchor(saved.anchor.itemId);
      if (targetScrollTop !== null) {
        return targetScrollTop + saved.anchor.offsetFromTop;
      }
    }
    return saved.scrollTop > 0 ? saved.scrollTop : 0;
  }, [routeKey, scrollPosition, restoreFromAnchor]);

  // ── 路由切换时的状态重置（useLayoutEffect，在 cleanup 保存之后执行）──
  // 关键设计：useLayoutEffect 在 DOM commit 后执行，且其 cleanup 在新 effect 之前触发。
  // 这确保了：旧路由的 cleanup（第 347 行）先保存 lastKnownGoodStateRef 快照，
  // 然后本 effect 才重置 refs —— 不会出现 "渲染阶段波动抹除快照" 的问题。
  const prevRouteKeyForResetRef = useRef(routeKey);
  useLayoutEffect(() => {
    const prevKey = prevRouteKeyForResetRef.current;
    if (prevKey === routeKey) {
      return;
    }

    // routeKey 已变更：上一个 useLayoutEffect 的 cleanup（第 347 行）已保存旧快照
    logId("ROUTE_CHANGE_RESET", { prevKey, newKey: routeKey });
    prevRouteKeyForResetRef.current = routeKey;

    // 检查新路由是否有保存的位置，没有则归零 DOM
    const saved = scrollPosition.getScrollPosition(routeKey);
    if (!saved) {
      const el = scrollRef.current;
      if (el && el.scrollTop !== 0) {
        el.scrollTop = 0;
      }
    }

    // 重置所有恢复相关 refs（为新一轮恢复做准备）
    hasRestoredRef.current = false;
    settledRouteKeyRef.current = null;
    lastRestoredItemCountRef.current = 0;
    lastLoadMoreItemCountRef.current = 0;
    hasInitialPositionedRef.current = false;
    cancelUnlockTimer();
    forcedUnlockScheduledRef.current = false;
    gridRef?.current?.cancelEnforceLock();
    isRestoringRef.current = true;
    pendingRestoreRef.current = null;
    lastKnownGoodStateRef.current = null;
    lastSaveRouteKeyRef.current = routeKey;
    // isNavigatingAwayRef 由挂载/卸载 useLayoutEffect 管理，此处不触动
  }, [
    routeKey,
    scrollPosition,
    scrollRef,
    cancelUnlockTimer,
    logId,
    gridRef?.current?.cancelEnforceLock,
  ]);

  // ── 保存：scroll 事件（三层冻结防御） ──────────────────────
  const getCurrentAnchorRef = useRef(getCurrentAnchor);
  getCurrentAnchorRef.current = getCurrentAnchor;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      debugLog("scroll listener: SKIPPED (scrollRef is null)");
      return;
    }

    debugLog("scroll listener: ATTACHED", {
      tag: el.tagName,
      cls: el.className?.slice(0, 40),
    });

    const rafIdRef = { current: 0 as number };

    const handleScroll = () => {
      // ═════════════════════════════════════════════════════
      // 入口冻结三重检查（按优先级排序）
      // ═════════════════════════════════════════════════════

      // F1: 导航冻结 — useLayoutEffect cleanup 已置位
      if (isNavigatingAwayRef.current) {
        debugLog("scroll event: BLOCKED (navigating away)");
        return;
      }

      // F2: 几何坍塌冻结 — scrollHeight 断崖式下跌检测
      // 正常滚动/无限加载：scrollHeight 增加或不变
      // 组件卸载：scrollHeight 骤降数千像素
      const prevSnapshot = lastKnownGoodStateRef.current;
      if (
        prevSnapshot &&
        prevSnapshot.scrollHeight - el.scrollHeight > COLLAPSE_THRESHOLD_PX
      ) {
        debugLog("scroll event: BLOCKED (geometry collapse detected)", {
          prevHeight: prevSnapshot.scrollHeight,
          currentHeight: el.scrollHeight,
          drop: prevSnapshot.scrollHeight - el.scrollHeight,
        });
        return;
      }

      // F3: 恢复锁 — 编程式 scrollTop 赋值期间
      if (rafIdRef.current) {
        return;
      }
      if (isRestoringRef.current || pendingRestoreRef.current) {
        debugLog("scroll event: BLOCKED", {
          isRestoring: isRestoringRef.current,
          hasPending: !!pendingRestoreRef.current,
        });
        return;
      }

      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = 0;
        saveScrollFrame({
          debug: debugLog,
          el,
          getCurrentAnchor: () => getCurrentAnchorRef.current?.(),
          isNavigatingAwayRef,
          isRestoringRef,
          lastKnownGoodStateRef,
          lastSaveRouteKeyRef,
          pendingRestoreRef,
          routeKey,
          saveScrollPosition: scrollPosition.saveScrollPosition,
        });
      });
    };

    const handleScrollEnd = () => {
      scrollPosition.flushPendingWrites();
    };

    el.addEventListener("scroll", handleScroll, { passive: true });
    el.addEventListener("scrollend", handleScrollEnd, { passive: true });

    // 保险丝：1.5 秒后强制熔断
    const safetyTimeout = setTimeout(() => {
      cancelUnlockTimer();
      if (pendingRestoreRef.current) {
        logId("SAFETY FUSE: force-clearing pending after 1.5s", {
          anchorId: pendingRestoreRef.current.anchorId,
          targetScrollTop: pendingRestoreRef.current.targetScrollTop,
        });
        pendingRestoreRef.current = null;
      }
      if (isRestoringRef.current) {
        logId("SAFETY FUSE: force-unlocking isRestoringRef");
        isRestoringRef.current = false;
      }
    }, 1500);

    return () => {
      clearTimeout(safetyTimeout);
      el.removeEventListener("scroll", handleScroll);
      el.removeEventListener("scrollend", handleScrollEnd);
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = 0;
      }
    };
  }, [scrollRef, routeKey, scrollPosition, logId, cancelUnlockTimer]);

  // ── 保存：路由离开 cleanup（DOM 直读 + 同步锚点双重保障） ──
  //
  // 问题 1 (RAF 尾斩)：useLayoutEffect cleanup 早于 RAF 回调执行，
  //   若最后滚动事件的 RAF 尚未触发，lastKnownGoodStateRef 是过期的。
  // 问题 2 (陈旧锚点)：snapshot.anchor 来自上次 RAF，而非当前 DOM 位置。
  //   系统恢复时锚点优先——陈旧锚点会把下次恢复拖回旧位置。
  //
  // 方案：DOM 直读 scrollTop + gridRef.getCurrentAnchor() 同步获取最新锚点。
  useLayoutEffect(() => {
    return () => {
      cancelUnlockTimer();
      forcedUnlockScheduledRef.current = false;

      const snapshot = lastKnownGoodStateRef.current;
      const frozenKey = lastSaveRouteKeyRef.current;
      const el = scrollRef.current;

      const domScrollTop = el?.scrollTop ?? 0;
      const finalScrollTop =
        domScrollTop > 0 ? domScrollTop : (snapshot?.scrollTop ?? 0);

      logId("LOG_CLEANUP", {
        closureKey: routeKey,
        frozenKey,
        snapshotScrollTop: snapshot?.scrollTop ?? null,
        domScrollTop,
        finalScrollTop,
        rafBehind:
          domScrollTop > 0 &&
          snapshot &&
          Math.abs(domScrollTop - snapshot.scrollTop) > 1,
        isNavigating: isNavigatingAwayRef.current,
      });

      if (finalScrollTop <= 0 && !snapshot?.anchor) {
        debugLog("cleanup save: SKIPPED (no position)", {
          routeKey,
          frozenKey,
        });
        return;
      }

      const latestAnchor = gridRef?.current?.getCurrentAnchor() ?? null;
      const effectiveAnchor = latestAnchor ?? snapshot?.anchor ?? undefined;

      scrollPosition.saveScrollPosition(
        frozenKey,
        finalScrollTop,
        effectiveAnchor
          ? {
              itemId: effectiveAnchor.itemId,
              offsetFromTop: effectiveAnchor.offsetFromTop,
              offsetRatio: effectiveAnchor.offsetRatio,
              estimatedGlobalIndex: effectiveAnchor.estimatedGlobalIndex,
              timestamp: Date.now(),
            }
          : undefined
      );
      scrollPosition.flushPendingWrites();
    };
  }, [
    routeKey,
    scrollPosition,
    cancelUnlockTimer,
    logId,
    scrollRef.current,
    gridRef?.current?.getCurrentAnchor,
  ]);

  // ── 恢复：数据驱动 + 长效 Pending ──────────────────────────
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      debugLog("restore: SKIPPED (no scrollRef)");
      return;
    }

    runRestoreEffect(
      {
        cancelUnlockTimer,
        debug: debugLog,
        el,
        gridRef,
        hasMore,
        itemCount,
        lastLoadMoreItemCountRef,
        logId,
        notifyRestoreSettled,
        onLoadMore,
        resolvePixelOffset,
        restoreFromAnchor,
        routeKey,
        scheduleForcedUnlock,
        scheduleUnlock,
        scrollPosition,
        seedSnapshotAfterRestore,
        refs: {
          hasInitialPositionedRef,
          hasRestoredRef,
          isRestoringRef,
          lastLoadMoreItemCountRef,
          lastRestoredItemCountRef,
          pendingRestoreRef,
        },
      },
      restoreReady,
      isPlaceholderData
    );
  }, [
    scrollRef,
    routeKey,
    restoreReady,
    isPlaceholderData,
    restoreFromAnchor,
    scrollPosition,
    itemCount,
    onLoadMore,
    hasMore,
    seedSnapshotAfterRestore,
    notifyRestoreSettled,
    gridRef,
    scheduleUnlock,
    logId,
    scheduleForcedUnlock,
    resolvePixelOffset,
    cancelUnlockTimer,
  ]);

  return { initialScrollTop, hasInitialPositionedRef, forceUnlock };
}
