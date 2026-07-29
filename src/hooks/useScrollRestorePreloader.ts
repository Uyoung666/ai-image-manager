import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useScrollPosition } from "@/contexts/ScrollPositionContext";
import { recordGalleryPerf } from "@/utils/gallery-perf";

const PRELOAD_TIMEOUT_MS = 1500;
const PRELOAD_PAGE_MARGIN = 1;

export function calculateScrollRestorePagesNeeded(
  estimatedIndex: number,
  pageSize: number
): number {
  const safePageSize = Math.max(1, pageSize);
  const targetPage = Math.floor(Math.max(0, estimatedIndex) / safePageSize);
  const pageMargin = targetPage <= 0 ? 0 : PRELOAD_PAGE_MARGIN;
  return Math.max(1, targetPage + 1 + pageMargin);
}

export type PreloadState =
  | "not-needed"
  | "checking"
  | "preloading"
  | "positioning"
  | "aborted";

interface UseScrollRestorePreloaderParams {
  currentItemCount: number;
  hasMore: boolean;
  isInitialLoading: boolean;
  onTimeout?: () => void;
  pageSize: number;
  routeKey: string;
}

interface UseScrollRestorePreloaderResult {
  hasSavedPosition: boolean;
  preloadState: PreloadState;
}

interface ResolvePreloadStateParams {
  currentItemCount: number;
  estimatedGlobalIndex?: number;
  hasMore: boolean;
  isInitialLoading: boolean;
  pageSize: number;
  savedScrollTop: number;
}

export function resolveScrollRestorePreloadState({
  currentItemCount,
  estimatedGlobalIndex,
  hasMore,
  isInitialLoading,
  pageSize,
  savedScrollTop,
}: ResolvePreloadStateParams): PreloadState {
  if (savedScrollTop <= 0) {
    return "not-needed";
  }
  if (isInitialLoading && currentItemCount === 0) {
    return "checking";
  }
  if (estimatedGlobalIndex === undefined) {
    return "positioning";
  }

  const needed = calculateScrollRestorePagesNeeded(
    estimatedGlobalIndex,
    pageSize
  );
  const currentPages = Math.ceil(currentItemCount / pageSize) || 1;
  return currentPages < needed && hasMore ? "preloading" : "positioning";
}

export function useScrollRestorePreloader({
  routeKey,
  pageSize,
  currentItemCount,
  hasMore,
  isInitialLoading,
  onTimeout,
}: UseScrollRestorePreloaderParams): UseScrollRestorePreloaderResult {
  const { getScrollPosition } = useScrollPosition();
  const readState = () => {
    const saved = getScrollPosition(routeKey);
    return resolveScrollRestorePreloadState({
      currentItemCount,
      estimatedGlobalIndex: saved?.anchor?.estimatedGlobalIndex,
      hasMore,
      isInitialLoading,
      pageSize,
      savedScrollTop: saved?.scrollTop ?? 0,
    });
  };
  const [preloadState, setPreloadState] =
    useState<PreloadState>(readState);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timeoutRouteKeyRef = useRef<string | null>(null);
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

  const clearPreloadTimeout = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    timeoutRouteKeyRef.current = null;
  }, []);

  useLayoutEffect(() => {
    if (
      timeoutRouteKeyRef.current !== null &&
      timeoutRouteKeyRef.current !== routeKey
    ) {
      clearPreloadTimeout();
    }

    const saved = getScrollPosition(routeKey);
    const nextState = resolveScrollRestorePreloadState({
      currentItemCount,
      estimatedGlobalIndex: saved?.anchor?.estimatedGlobalIndex,
      hasMore,
      isInitialLoading,
      pageSize,
      savedScrollTop: saved?.scrollTop ?? 0,
    });

    if (
      nextState === "preloading" &&
      saved?.anchor?.estimatedGlobalIndex !== undefined
    ) {
      const needed = calculateScrollRestorePagesNeeded(
        saved.anchor.estimatedGlobalIndex,
        pageSize
      );
      recordGalleryPerf("scrollRestorePagesNeeded", needed);
      recordGalleryPerf(
        "scrollRestoreCurrentPages",
        Math.ceil(currentItemCount / pageSize) || 1
      );
      if (timeoutRef.current === null) {
        timeoutRouteKeyRef.current = routeKey;
        timeoutRef.current = setTimeout(() => {
          timeoutRef.current = null;
          timeoutRouteKeyRef.current = null;
          onTimeoutRef.current?.();
          setPreloadState("aborted");
        }, PRELOAD_TIMEOUT_MS);
      }
    } else {
      clearPreloadTimeout();
    }

    setPreloadState((current) =>
      current === nextState ? current : nextState
    );
  }, [
    clearPreloadTimeout,
    currentItemCount,
    getScrollPosition,
    hasMore,
    isInitialLoading,
    pageSize,
    routeKey,
  ]);

  useEffect(() => clearPreloadTimeout, [clearPreloadTimeout]);

  return {
    hasSavedPosition:
      preloadState !== "not-needed" && preloadState !== "aborted",
    preloadState,
  };
}
