import { type CSSProperties, type RefObject, useMemo } from "react";
import type {
  HeaderPosition,
  MasonryItem,
} from "@/hooks/useMasonryLayout";
import { recordGalleryPerf } from "@/utils/gallery-perf";
import {
  binarySearchVisibilityStart,
  buildMasonryVisibilityIndex,
} from "@/utils/masonry-utils";

export const HEADER_HEIGHT = 36;
export const FAST_SCROLL_VELOCITY = 60;
export const VERY_FAST_SCROLL_VELOCITY = 180;
export const MAX_DYNAMIC_OVERSCAN_VIEWPORTS = 2;

export interface VisibleMasonryItem {
  index: number;
  style: CSSProperties;
}

export function estimateOverscanPx(
  positions: MasonryItem[],
  overscan: number,
  columnCount: number
): number {
  if (positions.length === 0) {
    return 400;
  }
  if (positions.length <= columnCount * 10) {
    const avgHeight =
      positions.reduce((sum, p) => sum + p.height, 0) / positions.length;
    return avgHeight * overscan;
  }
  const sampleSize = columnCount * 6;
  const step = Math.max(1, Math.floor(positions.length / sampleSize));
  let sum = 0;
  let count = 0;
  for (let i = 0; i < positions.length; i += step) {
    sum += positions[i].height;
    count++;
  }
  return (sum / count) * overscan;
}

export function getVelocityOverscanMultiplier(velocity: number): number {
  if (velocity >= VERY_FAST_SCROLL_VELOCITY) {
    return 3;
  }
  if (velocity >= FAST_SCROLL_VELOCITY) {
    return 2;
  }
  return 1;
}

export function clampDynamicOverscanPx(
  overscanPx: number,
  velocity: number,
  viewportHeight: number
): number {
  const dynamic = overscanPx * getVelocityOverscanMultiplier(velocity);
  const max =
    viewportHeight > 0 ? viewportHeight * MAX_DYNAMIC_OVERSCAN_VIEWPORTS : 0;
  return max > 0 ? Math.min(dynamic, max) : dynamic;
}

export function getVisibleMasonryItems(
  positions: MasonryItem[],
  scrollTop: number,
  viewportHeight: number,
  overscanPx: number,
  visibilityIndex?: number[]
): VisibleMasonryItem[] {
  if (positions.length === 0) {
    return [];
  }
  const top = scrollTop - overscanPx;
  const bottom = scrollTop + viewportHeight + overscanPx;
  const indexedBottoms =
    visibilityIndex?.length === positions.length
      ? visibilityIndex
      : buildMasonryVisibilityIndex(positions);
  const startIdx = binarySearchVisibilityStart(indexedBottoms, top);
  const result: VisibleMasonryItem[] = [];

  for (let i = startIdx; i < positions.length; i++) {
    const pos = positions[i];
    if (pos.top > bottom) {
      break;
    }
    if (pos.top + pos.height >= top) {
      result.push({
        index: i,
        style: {
          position: "absolute",
          top: pos.top,
          left: pos.left,
          width: pos.width,
          height: pos.height,
        },
      });
    }
  }
  return result;
}

export function getVisibleMasonryHeaders(
  headerPositions: HeaderPosition[],
  scrollTop: number,
  viewportHeight: number,
  overscanPx: number
): HeaderPosition[] {
  if (headerPositions.length === 0) {
    return [];
  }
  const top = scrollTop - overscanPx;
  const bottom = scrollTop + viewportHeight + overscanPx;
  return headerPositions.filter(
    (h) => h.top + HEADER_HEIGHT >= top && h.top <= bottom
  );
}

interface UseMasonryVirtualWindowOptions {
  columnCount: number;
  hasInitialPositionedRef: RefObject<boolean>;
  headerPositions: HeaderPosition[];
  initialScrollTop: number;
  overscan: number;
  positions: MasonryItem[];
  scrollRef: RefObject<HTMLDivElement | null>;
  scrollTop: number;
  velocity: number;
  viewportHeight: number;
  visibilityIndex: number[];
}

export function useMasonryVirtualWindow({
  columnCount,
  hasInitialPositionedRef,
  headerPositions,
  initialScrollTop,
  overscan,
  positions,
  scrollRef,
  scrollTop,
  velocity,
  visibilityIndex,
  viewportHeight,
}: UseMasonryVirtualWindowOptions): {
  overscanPx: number;
  velocityOverscanPx: number;
  visibleHeaders: HeaderPosition[];
  visibleItems: VisibleMasonryItem[];
} {
  const overscanPx = useMemo(
    () => estimateOverscanPx(positions, overscan, columnCount),
    [positions, overscan, columnCount]
  );

  const velocityOverscanPx = clampDynamicOverscanPx(
    overscanPx,
    velocity,
    viewportHeight
  );

  const visibleItems = useMemo(() => {
    const effectiveScrollTop = hasInitialPositionedRef.current
      ? (scrollRef.current?.scrollTop ?? scrollTop)
      : initialScrollTop;
    const effectiveHeight =
      viewportHeight > 0 ? viewportHeight : (scrollRef.current?.clientHeight ?? 0);
    const result = getVisibleMasonryItems(
      positions,
      effectiveScrollTop,
      effectiveHeight,
      velocityOverscanPx,
      visibilityIndex
    );
    recordGalleryPerf("masonryVisibleItems", result.length);
    recordGalleryPerf(
      "masonryOverscanMultiplier",
      getVelocityOverscanMultiplier(velocity)
    );
    return result;
  }, [
    columnCount,
    hasInitialPositionedRef,
    initialScrollTop,
    positions,
    scrollRef,
    scrollTop,
    velocity,
    velocityOverscanPx,
    visibilityIndex,
    viewportHeight,
  ]);

  const visibleHeaders = useMemo(() => {
    const effectiveHeight =
      viewportHeight > 0 ? viewportHeight : (scrollRef.current?.clientHeight ?? 0);
    return getVisibleMasonryHeaders(
      headerPositions,
      scrollTop,
      effectiveHeight,
      overscanPx
    );
  }, [headerPositions, scrollRef, scrollTop, viewportHeight, overscanPx]);

  return { overscanPx, velocityOverscanPx, visibleHeaders, visibleItems };
}
