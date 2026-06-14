import { useLocation } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { useScrollPosition } from "@/contexts/ScrollPositionContext";

// ── 内存日志缓冲区 ──────────────────────────────────────────
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
  const logId = (label: string, detail?: unknown) => {
    debugLog(label, { iid, ...((detail as object) || {}) });
  };

  useEffect(() => {
    logId("MOUNTED", {
      routeKey,
      restoreReady,
      isPlaceholder: isPlaceholderData,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // ── 种子函数：将恢复成功后的位置写入快照 ──────────────────
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
  }, [routeKey, scrollPosition, scrollRef, cancelUnlockTimer, logId]);

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

        // RAF 回调内再次冻结检查（防御在 RAF 排队期间发生的导航）
        if (isNavigatingAwayRef.current) {
          debugLog("RAF save: BLOCKED (navigating away in RAF)");
          return;
        }
        if (!el.isConnected) {
          debugLog("RAF save: SKIPPED (disconnected)");
          return;
        }
        if (isRestoringRef.current || pendingRestoreRef.current) {
          debugLog("RAF save: BLOCKED (RAF)");
          return;
        }

        const scrollTop = el.scrollTop;
        const anchor = getCurrentAnchorRef.current?.();

        // offsetRatio 已由 getCurrentAnchor 纯数学计算提供，
        // 无需 DOM 查找——彻底消除"纯净浏览态"下 DOM 采样失败的隐患。

        // 更新"最后已知良好快照"
        lastKnownGoodStateRef.current = {
          scrollTop,
          scrollHeight: el.scrollHeight,
          anchor: anchor
            ? {
                itemId: anchor.itemId,
                offsetFromTop: anchor.offsetFromTop,
                offsetRatio: anchor.offsetRatio,
                estimatedGlobalIndex: anchor.estimatedGlobalIndex,
              }
            : null,
        };

        // 固化 Key：记录此次写入使用的 routeKey
        lastSaveRouteKeyRef.current = routeKey;

        debugLog("RAF save: executing", {
          routeKey,
          scrollTop,
          anchorId: anchor?.itemId ?? null,
          offsetRatio: anchor?.offsetRatio,
        });
        scrollPosition.saveScrollPosition(
          routeKey,
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
  }, [scrollRef, routeKey, scrollPosition]);

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
  }, [routeKey, scrollPosition, cancelUnlockTimer, logId]);

  // ── 恢复：数据驱动 + 长效 Pending ──────────────────────────
  useLayoutEffect(() => {
    if (isPlaceholderData) {
      debugLog("restore: BLOCKED (isPlaceholderData)");
      return;
    }
    if (!restoreReady) {
      debugLog("restore: BLOCKED (restoreReady=false)");
      return;
    }

    const el = scrollRef.current;
    if (!el) {
      debugLog("restore: SKIPPED (no scrollRef)");
      return;
    }

    // ═══════════════════════════════════════════════════════
    // Priority 0：解析挂起的 Pending 恢复
    // ═══════════════════════════════════════════════════════
    const pending = pendingRestoreRef.current;
    if (pending) {
      debugLog("restore: PENDING retry", {
        anchorId: pending.anchorId,
        targetScrollTop: pending.targetScrollTop,
        itemCount,
        hasMore,
      });

      let resolved = false;
      let resolvedScrollTop = 0;
      let resolvedAnchorId: number | undefined;
      let resolvedAnchorOffset: number | undefined;

      if (pending.anchorId !== undefined && restoreFromAnchor) {
        const targetScrollTop = restoreFromAnchor(pending.anchorId);
        if (targetScrollTop !== null) {
          cancelUnlockTimer();
          isRestoringRef.current = true;

          // 优先使用 gridRef.scrollToItem（内容可寻址原子定位）
          if (gridRef?.current?.scrollToItem) {
            gridRef.current.scrollToItem(
              pending.anchorId,
              pending.offsetRatio ?? 0
            );
            scheduleForcedUnlock(
              pending.anchorId,
              pending.offsetFromTop,
              pending.offsetRatio
            );
            debugLog("pending: RESOLVED via gridRef.scrollToItem", {
              anchorId: pending.anchorId,
            });
          } else {
            const pixelOffset = resolvePixelOffset(
              pending.anchorId,
              pending.offsetFromTop ?? 0,
              pending.offsetRatio ?? 0
            );
            const desired = targetScrollTop + pixelOffset;
            el.scrollTop = Math.max(0, desired);
            debugLog("pending: RESOLVED via anchor (DOM scrollTop)", {
              anchorId: pending.anchorId,
              desired,
              pixelOffset,
            });
          }

          resolvedScrollTop = el.scrollTop;
          resolvedAnchorId = pending.anchorId;
          resolvedAnchorOffset = pending.offsetFromTop ?? 0;
          resolved = true;
        }
      }

      if (
        !resolved &&
        pending.targetScrollTop > 0 &&
        el.scrollHeight >= pending.targetScrollTop
      ) {
        cancelUnlockTimer();
        isRestoringRef.current = true;
        if (gridRef?.current?.scrollToPixel) {
          gridRef.current.scrollToPixel(pending.targetScrollTop);
        } else {
          const maxScroll = el.scrollHeight - el.clientHeight;
          el.scrollTop = Math.min(pending.targetScrollTop, maxScroll);
        }
        debugLog("pending: RESOLVED via pixel fallback", {
          targetScrollTop: pending.targetScrollTop,
          scrollHeight: el.scrollHeight,
        });
        resolvedScrollTop = el.scrollTop;
        resolved = true;
      }

      if (resolved) {
        pendingRestoreRef.current = null;
        lastLoadMoreItemCountRef.current = 0;
        hasRestoredRef.current = true;
        hasInitialPositionedRef.current = true;
        lastRestoredItemCountRef.current = itemCount;

        seedSnapshotAfterRestore(
          resolvedScrollTop,
          el.scrollHeight,
          resolvedAnchorId,
          resolvedAnchorOffset
        );

        logId("LOG_RESTORE", {
          routeKey,
          result: "pending_resolved",
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          anchorId: resolvedAnchorId,
          hasPending: false,
        });

        scheduleUnlock();
        return;
      }

      if (
        onLoadMore &&
        hasMore &&
        itemCount !== lastLoadMoreItemCountRef.current
      ) {
        lastLoadMoreItemCountRef.current = itemCount;
        debugLog("pending: calling onLoadMore()", { itemCount });
        onLoadMore();
      }
      return;
    }

    // ═══════════════════════════════════════════════════════
    // Priority 1：首次恢复 或 itemCount 增长重试
    // ═══════════════════════════════════════════════════════
    // 仅在存活的 pending 恢复周期内，itemCount 增长才触发重试。
    // 避免恢复成功后用户正常滚动触发无限加载 → itemCount 增长 →
    // 误触发重新恢复 → 将用户拖回旧位置的回归 Bug。
    if (hasRestoredRef.current) {
      if (
        itemCount > lastRestoredItemCountRef.current &&
        pendingRestoreRef.current
      ) {
        debugLog("restore: RETRY (itemCount grew, pending active)", {
          prev: lastRestoredItemCountRef.current,
          now: itemCount,
        });
        hasRestoredRef.current = false;
      } else {
        return;
      }
    }

    cancelUnlockTimer();
    isRestoringRef.current = true;
    const saved = scrollPosition.getScrollPosition(routeKey);

    logId("LOG_RESTORE", {
      routeKey,
      hasSaved: !!saved,
      savedScrollTop: saved?.scrollTop ?? null,
      savedAnchorId: saved?.anchor?.itemId ?? null,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      itemCount,
      isPending: false,
      phase: "priority1",
    });

    if (saved) {
      debugLog("restore: ATTEMPTING", {
        routeKey,
        savedScrollTop: saved.scrollTop,
        savedAnchorId: saved.anchor?.itemId ?? null,
        savedAnchorOffset: saved.anchor?.offsetFromTop ?? null,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      });

      let restored = false;
      let restoredScrollTop = 0;
      let restoredAnchorId: number | undefined;
      let restoredAnchorOffset: number | undefined;
      let newPending: PendingRestore | null = null;

      if (saved.anchor && restoreFromAnchor) {
        const targetScrollTop = restoreFromAnchor(saved.anchor.itemId);
        if (targetScrollTop === null) {
          debugLog("restore: anchor NOT FOUND, entering PENDING", {
            anchorId: saved.anchor.itemId,
          });
          newPending = {
            anchorId: saved.anchor.itemId,
            offsetFromTop: saved.anchor.offsetFromTop,
            offsetRatio: saved.anchor.offsetRatio ?? 0,
            targetScrollTop: saved.scrollTop,
          };
        } else {
          // 优先使用 gridRef.scrollToItem（内容可寻址原子定位）
          if (gridRef?.current?.scrollToItem) {
            gridRef.current.scrollToItem(
              saved.anchor.itemId,
              saved.anchor.offsetRatio ?? 0
            );
            scheduleForcedUnlock(
              saved.anchor.itemId,
              saved.anchor.offsetFromTop,
              saved.anchor.offsetRatio
            );
            debugLog("restore: anchor FOUND via gridRef.scrollToItem", {
              anchorId: saved.anchor.itemId,
            });
          } else {
            const pixelOffset = resolvePixelOffset(
              saved.anchor.itemId,
              saved.anchor.offsetFromTop,
              saved.anchor.offsetRatio ?? 0
            );
            const desired = targetScrollTop + pixelOffset;
            el.scrollTop = Math.max(0, desired);
            debugLog("restore: anchor FOUND (DOM scrollTop)", {
              desired,
              pixelOffset,
            });
          }
          restoredScrollTop = el.scrollTop;
          restoredAnchorId = saved.anchor.itemId;
          restoredAnchorOffset = saved.anchor.offsetFromTop;
          restored = true;
        }
      }

      if (!(restored || newPending) && saved.scrollTop > 0) {
        if (saved.scrollTop > el.scrollHeight) {
          debugLog("restore: pixel exceeds scrollHeight, entering PENDING", {
            targetScrollTop: saved.scrollTop,
            scrollHeight: el.scrollHeight,
          });
          newPending = { targetScrollTop: saved.scrollTop };
        } else {
          const maxScroll = el.scrollHeight - el.clientHeight;
          debugLog("restore: pixel fallback", { scrollTop: saved.scrollTop });
          el.scrollTop = Math.min(saved.scrollTop, maxScroll);
          restoredScrollTop = el.scrollTop;
          restored = true;
        }
      }

      if (newPending) {
        pendingRestoreRef.current = newPending;
        hasRestoredRef.current = true;
        hasInitialPositionedRef.current = true;
        lastRestoredItemCountRef.current = itemCount;

        logId("LOG_RESTORE", {
          routeKey,
          result: "pending",
          targetScrollTop: newPending.targetScrollTop,
          anchorId: newPending.anchorId,
          hasPending: true,
        });

        if (onLoadMore && hasMore) {
          lastLoadMoreItemCountRef.current = itemCount;
          debugLog("pending: initial onLoadMore() call", { itemCount });
          onLoadMore();
        }
        return;
      }

      if (restored) {
        hasRestoredRef.current = true;
        hasInitialPositionedRef.current = true;
        lastRestoredItemCountRef.current = itemCount;

        seedSnapshotAfterRestore(
          restoredScrollTop,
          el.scrollHeight,
          restoredAnchorId,
          restoredAnchorOffset
        );

        logId("LOG_RESTORE", {
          routeKey,
          result: "restored",
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          anchorId: restoredAnchorId,
          hasPending: false,
        });

        scheduleUnlock();
        return;
      }
    } else {
      logId("LOG_RESTORE", {
        routeKey,
        result: "no_saved_position",
        hasSaved: false,
        hasPending: false,
      });
    }

    hasRestoredRef.current = true;
    hasInitialPositionedRef.current = true;
    lastRestoredItemCountRef.current = itemCount;

    logId("LOG_RESTORE", {
      routeKey,
      result: "fallthrough_unlock",
      hasPending: false,
    });

    scheduleUnlock();
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
  ]);

  return { initialScrollTop, hasInitialPositionedRef, forceUnlock };
}
