// biome-ignore-all lint/a11y/useKeyWithClickEvents: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/a11y/noStaticElementInteractions: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/a11y/noNoninteractiveElementInteractions: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/style/noExportedImports: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/suspicious/noExplicitAny: scoped component lint cleanup preserves existing UI behavior
import {
  forwardRef,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { isReducedMotionEnabled } from "@/actions/ui-preferences";
import { MasonryBackToTop } from "@/components/MasonryBackToTop";
import {
  type MasonryGridHandle,
  useMasonryAnchor,
} from "@/hooks/useMasonryAnchor";
import { useMasonryEndReached } from "@/hooks/useMasonryEndReached";
import {
  type GroupHeaderInput,
  type MasonryItem,
  useMasonryLayout,
} from "@/hooks/useMasonryLayout";
import { useMasonryMarquee } from "@/hooks/useMasonryMarquee";
import {
  getVelocityOverscanMultiplier,
  HEADER_HEIGHT,
  useMasonryVirtualWindow,
} from "@/hooks/useMasonryVirtualWindow";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
import { recordGalleryPerf, startGalleryPerfProbe } from "@/utils/gallery-perf";
import {
  getMasonryReflowAnchor,
  getMasonryReflowScrollTop,
  type MasonryReflowAnchor,
} from "@/utils/masonry-reflow";
import { binarySearchVisibilityStart } from "@/utils/masonry-utils";

export type { GroupHeaderInput as GroupHeader, MasonryGridHandle };

import { GALLERY_CONFIG } from "@/utils/gallery-config";
import { ensureGalleryPhotos } from "@/utils/gallery-data-source";
import { getReturnScrollTop } from "@/utils/gallery-return";

const SCROLL_TOP_EPSILON = 0.5;
const SCROLL_RENDER_STEP_PX = 96;
const REFLOW_ANCHOR_MAX_WIDTH_STEP = 64;
const IMAGE_RENDER_OVERSCAN_VIEWPORTS_BEFORE = 1;
const IMAGE_RENDER_OVERSCAN_VIEWPORTS_AFTER = 2;
const MIN_SCROLLBAR_THUMB_HEIGHT = 24;

function hasMatchingLayoutWidth(element: HTMLElement, width: number): boolean {
  if (element.clientWidth === 0) {
    return true;
  }
  const style = getComputedStyle(element);
  const contentWidth =
    element.clientWidth -
    (Number.parseFloat(style.paddingLeft) || 0) -
    (Number.parseFloat(style.paddingRight) || 0);
  return Math.abs(contentWidth - width) <= 1;
}

export function shouldRenderItemImage(
  style: React.CSSProperties,
  scrollTop: number,
  viewportHeight: number,
  direction?: number,
  velocity = 0
): boolean {
  if (viewportHeight <= 0) {
    return true;
  }
  const itemTop = Number(style.top) || 0;
  const itemHeight = Number(style.height) || 0;
  const forward = velocity >= 10.8 ? 0.5 : 2;
  let before = IMAGE_RENDER_OVERSCAN_VIEWPORTS_BEFORE;
  let after = IMAGE_RENDER_OVERSCAN_VIEWPORTS_AFTER - 1;
  if (direction !== undefined) {
    before = direction < 0 ? forward : 0.5;
    after = direction < 0 ? 0.5 : forward;
  }
  const imageTop = scrollTop - viewportHeight * before;
  const imageBottom = scrollTop + viewportHeight * (1 + after);
  return itemTop + itemHeight >= imageTop && itemTop <= imageBottom;
}

export function shouldUpdateScrollRenderTop(
  currentScrollTop: number,
  renderedScrollTop: number,
  viewport?: {
    positions: MasonryItem[];
    visibilityIndex: number[];
    height: number;
  }
): boolean {
  if (Math.abs(currentScrollTop - renderedScrollTop) >= SCROLL_RENDER_STEP_PX) {
    return true;
  }
  if (!viewport || viewport.height <= 0) {
    return false;
  }
  const { positions, visibilityIndex, height } = viewport;
  const start = binarySearchVisibilityStart(
    visibilityIndex,
    Math.min(currentScrollTop, renderedScrollTop)
  );
  const end = Math.max(currentScrollTop, renderedScrollTop) + height;
  for (
    let index = start;
    index < positions.length && positions[index].top <= end;
    index++
  ) {
    const item = positions[index];
    const visibleNow =
      item.top + item.height >= currentScrollTop &&
      item.top <= currentScrollTop + height;
    const visibleBefore =
      item.top + item.height >= renderedScrollTop &&
      item.top <= renderedScrollTop + height;
    if (visibleNow !== visibleBefore) {
      return true;
    }
  }
  return false;
}

/** Bound new offscreen work independently of the retained DOM/image window. */
export function getMasonryImageRequests(
  candidates: Array<{ id: number; style: React.CSSProperties }>,
  scrollTop: number,
  viewportHeight: number,
  direction = 1,
  velocity = 0
): Set<number> {
  const result = new Set<number>();
  const nearby: Array<{ id: number; direction: number; distance: number }> = [];
  for (const { id, style } of candidates) {
    const top = Number(style.top) || 0;
    const bottom = top + (Number(style.height) || 0);
    if (bottom >= scrollTop && top <= scrollTop + viewportHeight) {
      result.add(id);
    } else if (
      shouldRenderItemImage(
        style,
        scrollTop,
        viewportHeight,
        direction,
        velocity
      )
    ) {
      const before = bottom < scrollTop;
      nearby.push({
        id,
        direction: before === direction < 0 ? 0 : 1,
        distance: before
          ? scrollTop - bottom
          : top - scrollTop - viewportHeight,
      });
    }
  }
  nearby.sort((a, b) => a.direction - b.direction || a.distance - b.distance);
  for (const item of nearby.slice(0, GALLERY_CONFIG.imagePrefetchCandidates)) {
    result.add(item.id);
  }
  return result;
}

export interface MasonryImageOptions {
  imageHeight?: number;
  imageIdle?: boolean;
  imagePriority?: 0 | 1 | 2;
  imageVisible?: boolean;
  imageWidth?: number;
  renderImage: boolean;
  requestImage?: boolean;
}

export function getMasonryReturnScrollTop(
  input: Parameters<typeof getReturnScrollTop>[0] & { paddingTop?: number }
): number | null {
  const { cardTop, cardHeight, scrollTop, clientHeight, topInset, paddingTop } =
    input;
  if (
    paddingTop !== undefined &&
    cardTop + paddingTop >= scrollTop + topInset &&
    cardTop + cardHeight + paddingTop <= scrollTop + clientHeight
  ) {
    return null;
  }
  return getReturnScrollTop(input);
}

export interface MasonryScrollRestoreRequest {
  id: number;
  scrollTop: number;
}

export interface MasonryPhotoFocusRequest {
  id: number;
  photoId: number;
  /** null keeps a virtual sequence mounted until its member is measured. */
  targetRect?: {
    top: number;
    height: number;
    layoutWidth: number;
    innerScrollTop?: number;
    outerScrollTop?: number;
  } | null;
}

interface MasonryGridProps {
  className?: string;
  columnCount: number;
  containerWidth: number;
  gap: number;
  groupHeaders?: GroupHeaderInput[];
  hasMore?: boolean;
  isLoadingMore?: boolean;
  isPlaceholderData?: boolean;
  itemStateVersion?: unknown;
  items: Array<{
    fullWidth?: boolean;
    id: number;
    width: number;
    height: number;
    [key: string]: any;
  }>;
  onBackToTop?: () => void;
  onEndReached?: () => void;
  onMarqueeSelect?: (ids: Set<number>) => void;
  onPhotoFocusSettled?: (request: number) => void;
  onRestoreSettled?: (routeKey: string) => void;
  onReturnLocated?: (request: number) => void;
  onScrollRestored?: (request: number) => void;
  onScrollTopChange?: (scrollTop: number) => void;
  overscan?: number;
  photoFocusRequest?: MasonryPhotoFocusRequest | null;
  renderItem: (
    item: any,
    index: number,
    style: React.CSSProperties,
    options: MasonryImageOptions
  ) => ReactNode;
  restoreGateReady?: boolean;
  returnToMemberId?: number | null;
  returnToPhotoId?: number | null;
  returnToPhotoRequest?: number;
  routeKey: string;
  scrollRestoreRequest?: MasonryScrollRestoreRequest;
  scrollToAlignment?: "center" | "start";
  scrollToId?: number | null;
  selectionActive?: boolean;
  showGroupHeaders?: boolean;
  topInset?: number;
}

export const MasonryGrid = memo(
  forwardRef<MasonryGridHandle, MasonryGridProps>(function MasonryGrid(
    {
      items: inputItems,
      containerWidth,
      columnCount,
      gap,
      groupHeaders,
      overscan = 5,
      renderItem,
      onBackToTop,
      onEndReached,
      hasMore = false,
      isLoadingMore = false,
      onMarqueeSelect,
      onRestoreSettled,
      onReturnLocated,
      onScrollRestored,
      onScrollTopChange,
      scrollToAlignment = "center",
      scrollToId,
      photoFocusRequest,
      onPhotoFocusSettled,
      className,
      selectionActive = false,
      showGroupHeaders = true,
      returnToPhotoId = null,
      returnToMemberId = null,
      returnToPhotoRequest = 0,
      routeKey,
      scrollRestoreRequest,
      restoreGateReady = true,
      isPlaceholderData = false,
      topInset = 0,
    }: MasonryGridProps,
    ref
  ) {
    const { t } = useTranslation();
    const scrollRef = useRef<HTMLDivElement>(null);
    const sentinelRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
      const surface = scrollRef.current;
      return surface ? startGalleryPerfProbe(surface) : undefined;
    }, []);
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportHeight, setViewportHeight] = useState(0);
    const [scrollHeight, setScrollHeight] = useState(0);
    const [showScrollTop, setShowScrollTop] = useState(false);
    const [isScrolling, setIsScrolling] = useState(false);
    const [currentTimeLabel, setCurrentTimeLabel] = useState("");
    const [scrollVelocity, setScrollVelocity] = useState(0);
    const scrollTopStateRef = useRef(0);
    const viewportHeightStateRef = useRef(0);
    const scrollHeightStateRef = useRef(0);
    const showScrollTopStateRef = useRef(false);
    const isScrollingStateRef = useRef(false);
    const currentTimeLabelRef = useRef("");
    const scrollVelocityRef = useRef(0);
    const scrollOverscanMultiplierRef = useRef(1);
    const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const rafRef = useRef<number>(0);
    const prevScrollYRef = useRef(0);
    const prevScrollTimeRef = useRef(performance.now());
    const scrollDirectionRef = useRef(1);
    const reflowScrollTopRef = useRef<number | null>(null);
    const reflowAnchorRef = useRef<
      (MasonryReflowAnchor & { expiresAt: number }) | null
    >(null);
    const returnToPhotoAutoScrollRef = useRef(false);
    const returnToPhotoFocusFrameRef = useRef<number>(0);
    const completedPhotoFocusRef = useRef<number | null>(null);
    const completedPhotoFocusRectRef =
      useRef<MasonryPhotoFocusRequest["targetRect"]>(undefined);
    const cancelledPhotoFocusRef = useRef<number | null>(null);
    const onPhotoFocusSettledRef = useRef(onPhotoFocusSettled);
    onPhotoFocusSettledRef.current = onPhotoFocusSettled;
    const photoFocusFrameRef = useRef(0);
    const latestPhotoFocusRef = useRef(photoFocusRequest);
    latestPhotoFocusRef.current = photoFocusRequest;
    const cancelPhotoFocus = useCallback(() => {
      if (latestPhotoFocusRef.current) {
        completedPhotoFocusRef.current = latestPhotoFocusRef.current.id;
        cancelledPhotoFocusRef.current = latestPhotoFocusRef.current.id;
      }
      if (photoFocusFrameRef.current) {
        cancelAnimationFrame(photoFocusFrameRef.current);
        photoFocusFrameRef.current = 0;
      }
    }, []);
    const routeForceUnlockRef = useRef<(() => void) | null>(null);
    const scrollbarThumbRef = useRef<HTMLDivElement>(null);
    const scrollbarDragRef = useRef<{
      pointerId: number;
      startY: number;
      startScrollTop: number;
      travel: number;
    } | null>(null);

    const layout = useMasonryLayout(
      inputItems,
      containerWidth,
      columnCount,
      gap,
      groupHeaders,
      routeKey,
      showGroupHeaders
    );
    const { positions, totalHeight, headerPositions, visibilityIndex } = layout;
    const viewportLayoutRef = useRef({ positions, visibilityIndex });
    viewportLayoutRef.current = { positions, visibilityIndex };
    const items = (layout.renderItems ?? inputItems) as typeof inputItems;

    const idToIndexMap = useMemo(
      () => new Map(items.map((item, i) => [item.id, i])),
      [items]
    );

    const { getCurrentAnchor, getEnforcedAnchor, gridRef } = useMasonryAnchor({
      containerWidth,
      forwardedRef: ref,
      forceUnlockRef: routeForceUnlockRef,
      idToIndexMap,
      items,
      positions,
      scrollRef,
      visibilityIndex,
    });

    const restoreReady =
      positions.length > 0 && !isPlaceholderData && restoreGateReady;
    const getRouteKey = useCallback(() => routeKey, [routeKey]);
    const restoreFromAnchor = useCallback(
      (anchorItemId: number) => {
        const idx = idToIndexMap.get(anchorItemId);
        if (idx === undefined || !positions[idx]) {
          return null;
        }
        return positions[idx].top;
      },
      [idToIndexMap, positions]
    );
    const { initialScrollTop, hasInitialPositionedRef, forceUnlock } =
      useRouteScrollRestoration(scrollRef, {
        getRouteKey,
        getCurrentAnchor,
        restoreFromAnchor,
        restoreReady,
        itemCount: items.length,
        isPlaceholderData,
        onLoadMore: onEndReached,
        hasMore,
        gridRef,
        onRestoreSettled,
      });

    useEffect(() => {
      routeForceUnlockRef.current = forceUnlock;
    }, [forceUnlock]);

    const { checkNearBottom } = useMasonryEndReached({
      containerWidth,
      hasMore,
      isLoadingMore,
      onEndReached,
      scrollRef,
      sentinelRef,
      totalHeight,
    });

    const { handleMarqueeStart, marquee } = useMasonryMarquee({
      items,
      onMarqueeSelect,
      positions,
      scrollRef,
      visibilityIndex,
    });

    const headerPositionsRef = useRef(headerPositions);
    headerPositionsRef.current = headerPositions;

    const syncScrollMetrics = useCallback((el: HTMLDivElement) => {
      if (el.clientHeight !== viewportHeightStateRef.current) {
        viewportHeightStateRef.current = el.clientHeight;
        setViewportHeight(el.clientHeight);
      }
      if (el.scrollHeight !== scrollHeightStateRef.current) {
        scrollHeightStateRef.current = el.scrollHeight;
        setScrollHeight(el.scrollHeight);
      }
    }, []);

    const updateScrollbarThumbPosition = useCallback(
      (el: HTMLDivElement) => {
        const thumb = scrollbarThumbRef.current;
        if (!thumb) {
          return;
        }
        const trackHeight = Math.max(0, el.clientHeight - topInset);
        const scrollRange = Math.max(0, el.scrollHeight - el.clientHeight);
        if (trackHeight <= 0 || scrollRange <= 0) {
          thumb.style.display = "none";
          return;
        }
        const thumbHeight = Math.min(
          trackHeight,
          Math.max(
            MIN_SCROLLBAR_THUMB_HEIGHT,
            (trackHeight * el.clientHeight) / el.scrollHeight
          )
        );
        const travel = Math.max(0, trackHeight - thumbHeight);
        const offset = travel > 0 ? (el.scrollTop / scrollRange) * travel : 0;
        thumb.style.display = "block";
        thumb.style.height = `${thumbHeight}px`;
        thumb.style.transform = `translateY(${offset}px)`;
      },
      [topInset]
    );

    const handleScroll = useCallback(() => {
      const reflowTop = reflowScrollTopRef.current;
      const isReflowScroll =
        reflowTop !== null &&
        Math.abs((scrollRef.current?.scrollTop ?? 0) - reflowTop) <=
          SCROLL_TOP_EPSILON;
      // Native scroll notifications can repeat one programmatic offset. Keep
      // the marker until the position changes so they cannot release the anchor.
      if (!isReflowScroll) {
        reflowScrollTopRef.current = null;
      }
      if (!(returnToPhotoAutoScrollRef.current || isReflowScroll)) {
        reflowAnchorRef.current = null;
        // Scroll notifications can arrive from an earlier resize or return.
        // Explicit input gestures cancel click focus, not these notifications.
      }
      if (returnToPhotoAutoScrollRef.current || isReflowScroll) {
        returnToPhotoAutoScrollRef.current = false;
      } else if (
        pendingReturnToPhotoRequestRef.current !== null ||
        pendingReturnFocusIdRef.current !== null
      ) {
        if (returnToPhotoFrameRef.current) {
          cancelAnimationFrame(returnToPhotoFrameRef.current);
          returnToPhotoFrameRef.current = 0;
        }
        if (returnToPhotoFocusFrameRef.current) {
          cancelAnimationFrame(returnToPhotoFocusFrameRef.current);
          returnToPhotoFocusFrameRef.current = 0;
        }
        pendingReturnToPhotoRequestRef.current = null;
        pendingReturnFocusIdRef.current = null;
      }
      if (rafRef.current) {
        return;
      }
      rafRef.current = requestAnimationFrame(() => {
        const frameStart = performance.now();
        rafRef.current = 0;
        const el = scrollRef.current;
        if (!el) {
          return;
        }

        const now = performance.now();
        const delta = el.scrollTop - prevScrollYRef.current;
        const dy =
          Math.abs(delta) / Math.max(1, now - prevScrollTimeRef.current);
        prevScrollTimeRef.current = now;
        if (delta !== 0) {
          scrollDirectionRef.current = Math.sign(delta);
        }
        onScrollTopChange?.(el.scrollTop);
        prevScrollYRef.current = el.scrollTop;
        const nextOverscanMultiplier = getVelocityOverscanMultiplier(dy);
        if (nextOverscanMultiplier !== scrollOverscanMultiplierRef.current) {
          scrollOverscanMultiplierRef.current = nextOverscanMultiplier;
          scrollVelocityRef.current = dy;
          setScrollVelocity(dy);
        }

        if (
          shouldUpdateScrollRenderTop(el.scrollTop, scrollTopStateRef.current, {
            ...viewportLayoutRef.current,
            height: el.clientHeight,
          })
        ) {
          scrollTopStateRef.current = el.scrollTop;
          setScrollTop(el.scrollTop);
          recordGalleryPerf("masonryScrollRenderTopUpdates", 1);
        }
        syncScrollMetrics(el);
        updateScrollbarThumbPosition(el);

        const nextShowScrollTop = el.scrollTop > el.clientHeight * 2;
        if (nextShowScrollTop !== showScrollTopStateRef.current) {
          showScrollTopStateRef.current = nextShowScrollTop;
          setShowScrollTop(nextShowScrollTop);
        }
        if (!isScrollingStateRef.current) {
          isScrollingStateRef.current = true;
          setIsScrolling(true);
        }
        if (scrollTimerRef.current) {
          clearTimeout(scrollTimerRef.current);
        }
        scrollTimerRef.current = setTimeout(() => {
          isScrollingStateRef.current = false;
          setIsScrolling(false);
          if (scrollOverscanMultiplierRef.current !== 1) {
            scrollOverscanMultiplierRef.current = 1;
            scrollVelocityRef.current = 0;
            setScrollVelocity(0);
          }
          const latest =
            scrollRef.current?.scrollTop ?? scrollTopStateRef.current;
          if (
            Math.abs(latest - scrollTopStateRef.current) > SCROLL_TOP_EPSILON
          ) {
            scrollTopStateRef.current = latest;
            setScrollTop(latest);
            recordGalleryPerf("masonryScrollRenderTopUpdates", 1);
          }
        }, GALLERY_CONFIG.scrollIdleMs);

        const headers = headerPositionsRef.current;
        let nextLabel = "";
        if (headers.length > 0) {
          let lo = 0;
          let hi = headers.length;
          while (lo < hi) {
            const mid = Math.floor((lo + hi) / 2);
            if (headers[mid].top <= el.scrollTop + 100) {
              lo = mid + 1;
            } else {
              hi = mid;
            }
          }
          nextLabel = headers[Math.max(0, lo - 1)]?.label ?? "";
          if (!nextLabel) {
            nextLabel = headers[0]?.label || "";
          }
        }
        if (currentTimeLabelRef.current !== nextLabel) {
          currentTimeLabelRef.current = nextLabel;
          setCurrentTimeLabel(nextLabel);
        }

        checkNearBottom(dy);
        recordGalleryPerf(
          "masonryScrollFrameMs",
          performance.now() - frameStart
        );
      });
    }, [
      checkNearBottom,
      onScrollTopChange,
      syncScrollMetrics,
      updateScrollbarThumbPosition,
    ]);

    useLayoutEffect(() => {
      const el = scrollRef.current;
      if (el && el.clientHeight > 0) {
        syncScrollMetrics(el);
      }
    }, [syncScrollMetrics]);

    useEffect(() => {
      const el = scrollRef.current;
      if (!el) {
        return;
      }
      el.addEventListener("scroll", handleScroll, { passive: true });
      return () => el.removeEventListener("scroll", handleScroll);
    }, [handleScroll]);

    useEffect(() => {
      const startInteraction = () => {
        // A new gesture (including a detail-panel handle outside the grid)
        // starts from the current viewport, not the preceding resize's anchor.
        reflowAnchorRef.current = null;
        reflowScrollTopRef.current = null;
        cancelPhotoFocus();
      };
      const el = scrollRef.current;
      const handleScrollKey = (event: KeyboardEvent) => {
        if (
          [
            "ArrowUp",
            "ArrowDown",
            "PageUp",
            "PageDown",
            "Home",
            "End",
            " ",
          ].includes(event.key)
        ) {
          cancelPhotoFocus();
        }
      };
      window.addEventListener("pointerdown", startInteraction, true);
      el?.addEventListener("wheel", cancelPhotoFocus, { passive: true });
      el?.addEventListener("touchstart", cancelPhotoFocus, { passive: true });
      el?.addEventListener("keydown", handleScrollKey);
      return () => {
        window.removeEventListener("pointerdown", startInteraction, true);
        el?.removeEventListener("wheel", cancelPhotoFocus);
        el?.removeEventListener("touchstart", cancelPhotoFocus);
        el?.removeEventListener("keydown", handleScrollKey);
      };
    }, [cancelPhotoFocus]);

    useEffect(() => {
      return () => {
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = 0;
        }
        if (scrollTimerRef.current) {
          clearTimeout(scrollTimerRef.current);
          scrollTimerRef.current = null;
        }
      };
    }, []);

    useEffect(() => {
      const el = scrollRef.current;
      if (!el) {
        return;
      }
      const observer = new ResizeObserver(() => {
        syncScrollMetrics(el);
      });
      observer.observe(el);
      return () => observer.disconnect();
    }, [syncScrollMetrics]);

    const prevPositionsRef = useRef(positions);
    const prevItemsRef = useRef(items);
    const prevColumnCountRef = useRef(columnCount);
    const prevGapRef = useRef(gap);
    const prevTopInsetRef = useRef(topInset);
    const prevPaddingTopRef = useRef(0);
    const prevScrollToAlignmentRef = useRef(scrollToAlignment);
    const prevScrollToIdRef = useRef(scrollToId);
    const prevPhotoFocusRequestRef = useRef(photoFocusRequest);
    const prevReturnToPhotoRequestRef = useRef(0);
    const prevReturnToPhotoIdRef = useRef(returnToPhotoId);
    const completedReturnRequestRef = useRef(0);
    const pendingReturnToPhotoRequestRef = useRef<number | null>(null);
    const prevRouteKeyRef = useRef(routeKey);
    const completedScrollRestoreRef = useRef<number | null>(null);
    const prevContainerWidthRef = useRef(containerWidth);
    const pendingReturnFocusIdRef = useRef<number | null>(null);
    const returnToPhotoFrameRef = useRef<number>(0);
    const latestPositionsRef = useRef(positions);
    const latestIdToIndexMapRef = useRef(idToIndexMap);
    const latestReturnToPhotoIdRef = useRef(returnToPhotoId);
    latestPositionsRef.current = positions;
    latestIdToIndexMapRef.current = idToIndexMap;
    latestReturnToPhotoIdRef.current = returnToPhotoId;
    const onReturnLocatedRef = useRef(onReturnLocated);
    onReturnLocatedRef.current = onReturnLocated;

    const scrollElement = scrollRef.current;
    const effectiveViewportHeight =
      scrollElement?.clientHeight || viewportHeight;
    const scrollStyle = scrollElement ? getComputedStyle(scrollElement) : null;
    const paddingTop =
      topInset > 0
        ? topInset + 8
        : Number.parseFloat(scrollStyle?.paddingTop ?? "0") || 0;
    const paddingBottom =
      Number.parseFloat(scrollStyle?.paddingBottom ?? "0") || 0;
    const photoFocusPending =
      photoFocusRequest != null &&
      photoFocusRequest.id !== cancelledPhotoFocusRef.current &&
      (photoFocusRequest.id !== completedPhotoFocusRef.current ||
        photoFocusRequest.targetRect !== completedPhotoFocusRectRef.current);
    const clampScrollTop = (value: number) =>
      Math.max(
        0,
        Math.min(
          value,
          totalHeight + paddingTop + paddingBottom - effectiveViewportHeight
        )
      );
    let pendingReflowAnchor: MasonryReflowAnchor | null = null;
    const scrollRestorePending =
      scrollRestoreRequest !== undefined &&
      scrollRestoreRequest.id !== completedScrollRestoreRef.current;
    const plannedScrollTop = (() => {
      if (
        !scrollElement ||
        prevRouteKeyRef.current !== routeKey ||
        !restoreReady ||
        !hasInitialPositionedRef.current
      ) {
        return null;
      }
      if (scrollRestorePending && scrollRestoreRequest) {
        return clampScrollTop(scrollRestoreRequest.scrollTop);
      }
      const currentScrollTop = scrollElement.scrollTop;
      const geometryChanged =
        containerWidth !== prevContainerWidthRef.current ||
        columnCount !== prevColumnCountRef.current ||
        gap !== prevGapRef.current ||
        topInset !== prevTopInsetRef.current;
      let reflowScrollTop: number | null = null;
      if (
        geometryChanged &&
        containerWidth > 0 &&
        prevContainerWidthRef.current > 0 &&
        (positions !== prevPositionsRef.current ||
          topInset !== prevTopInsetRef.current) &&
        prevPositionsRef.current.length > 0
      ) {
        const enforced = getEnforcedAnchor();
        const enforcedIndex = enforced
          ? idToIndexMap.get(enforced.itemId)
          : undefined;
        const enforcedPosition =
          enforcedIndex === undefined ? undefined : positions[enforcedIndex];
        const existingAnchor = reflowAnchorRef.current;
        pendingReflowAnchor =
          existingAnchor &&
          existingAnchor.expiresAt > Date.now() &&
          Math.abs(containerWidth - prevContainerWidthRef.current) <=
            REFLOW_ANCHOR_MAX_WIDTH_STEP
            ? existingAnchor
            : getMasonryReflowAnchor({
                previousItems: prevItemsRef.current,
                previousPaddingTop: prevPaddingTopRef.current,
                previousPositions: prevPositionsRef.current,
                scrollTop: currentScrollTop,
                topInset: prevTopInsetRef.current,
              });
        reflowScrollTop = clampScrollTop(
          enforced && enforcedPosition
            ? enforcedPosition.top + enforcedPosition.height * enforced.ratio
            : getMasonryReflowScrollTop({
                anchor: pendingReflowAnchor,
                idToIndexMap,
                nextPaddingTop: paddingTop,
                positions,
                previousItems: prevItemsRef.current,
                previousPaddingTop: prevPaddingTopRef.current,
                previousPositions: prevPositionsRef.current,
                scrollTop: currentScrollTop,
                topInset: prevTopInsetRef.current,
              })
        );
      }
      const positionedScrollTop = reflowScrollTop ?? currentScrollTop;
      const returnPending =
        returnToPhotoId !== null &&
        returnToPhotoRequest > 0 &&
        (returnToPhotoRequest !== prevReturnToPhotoRequestRef.current ||
          pendingReturnToPhotoRequestRef.current === returnToPhotoRequest ||
          (returnToPhotoId !== prevReturnToPhotoIdRef.current &&
            completedReturnRequestRef.current !== returnToPhotoRequest));
      if (returnPending) {
        pendingReflowAnchor = null;
        const index = idToIndexMap.get(returnToPhotoId);
        const position = index === undefined ? undefined : positions[index];
        if (!position) {
          return null;
        }
        const memberContainerVisible =
          returnToMemberId !== null &&
          returnToPhotoId < 0 &&
          position.top + position.height > positionedScrollTop &&
          position.top <
            positionedScrollTop + effectiveViewportHeight - topInset;
        const target = memberContainerVisible
          ? null
          : getMasonryReturnScrollTop({
              cardHeight: position.height,
              cardTop: position.top,
              clientHeight: effectiveViewportHeight,
              paddingTop,
              scrollTop: positionedScrollTop,
              topInset,
            });
        return target === null ? reflowScrollTop : clampScrollTop(target);
      }
      if (photoFocusPending && photoFocusRequest) {
        const index = idToIndexMap.get(photoFocusRequest.photoId);
        const position = index === undefined ? undefined : positions[index];
        if (position) {
          pendingReflowAnchor = null;
          const rect = photoFocusRequest.targetRect;
          const matchingRect =
            rect && Math.abs(rect.layoutWidth - position.width) <= 1
              ? rect
              : null;
          // A member request must wait for its projected rectangle. Centering
          // the whole tray here creates a visible detour before member focus.
          if (rect !== undefined && !matchingRect) {
            return null;
          }
          if (matchingRect?.outerScrollTop !== undefined) {
            return clampScrollTop(matchingRect.outerScrollTop);
          }
          const availableHeight = Math.max(
            0,
            effectiveViewportHeight - topInset - paddingBottom
          );
          return clampScrollTop(
            position.top +
              paddingTop +
              (matchingRect
                ? matchingRect.top + matchingRect.height / 2
                : position.height / 2) -
              (topInset + availableHeight / 2)
          );
        }
      }
      if (
        scrollToId != null &&
        (scrollToId !== prevScrollToIdRef.current ||
          scrollToAlignment !== prevScrollToAlignmentRef.current)
      ) {
        pendingReflowAnchor = null;
        const index = idToIndexMap.get(scrollToId);
        const position = index === undefined ? undefined : positions[index];
        if (
          position &&
          (position.top < positionedScrollTop + topInset - paddingTop ||
            position.top + position.height >
              positionedScrollTop + effectiveViewportHeight - paddingTop)
        ) {
          return clampScrollTop(
            scrollToAlignment === "start"
              ? position.top + paddingTop - topInset
              : position.top +
                  paddingTop -
                  (effectiveViewportHeight + topInset - position.height) / 2
          );
        }
      }
      return reflowScrollTop;
    })();
    // Select the final virtual window before React can unmount retained cards.
    const effectiveScrollTop =
      plannedScrollTop ??
      (hasInitialPositionedRef.current
        ? (scrollElement?.scrollTop ?? scrollTop)
        : initialScrollTop);

    useLayoutEffect(() => {
      const prevReturnToPhotoRequest = prevReturnToPhotoRequestRef.current;
      const prevReturnToPhotoId = prevReturnToPhotoIdRef.current;
      const prevRouteKey = prevRouteKeyRef.current;
      const scrollTargetChanged = scrollToId !== prevScrollToIdRef.current;
      if (!photoFocusRequest && prevPhotoFocusRequestRef.current) {
        completedPhotoFocusRef.current = prevPhotoFocusRequestRef.current.id;
      }
      prevPhotoFocusRequestRef.current = photoFocusRequest;
      prevPositionsRef.current = positions;
      prevItemsRef.current = items;
      prevColumnCountRef.current = columnCount;
      prevGapRef.current = gap;
      prevTopInsetRef.current = topInset;
      prevPaddingTopRef.current = paddingTop;
      prevScrollToAlignmentRef.current = scrollToAlignment;
      prevScrollToIdRef.current = scrollToId;
      prevReturnToPhotoRequestRef.current = returnToPhotoRequest;
      prevReturnToPhotoIdRef.current = returnToPhotoId;
      prevRouteKeyRef.current = routeKey;
      prevContainerWidthRef.current = containerWidth;

      const returnRequestChanged =
        returnToPhotoRequest !== prevReturnToPhotoRequest;
      if (
        prevRouteKey !== routeKey ||
        (returnRequestChanged && returnToPhotoRequest > 0) ||
        scrollRestorePending
      ) {
        cancelPhotoFocus();
      }
      if (
        photoFocusPending &&
        photoFocusRequest &&
        cancelledPhotoFocusRef.current !== photoFocusRequest.id &&
        plannedScrollTop !== null
      ) {
        gridRef.current?.cancelEnforceLock();
      }
      if (scrollTargetChanged || returnRequestChanged) {
        reflowAnchorRef.current = null;
      }
      if (
        returnRequestChanged ||
        (returnToPhotoId !== prevReturnToPhotoId &&
          returnToPhotoRequest > 0 &&
          completedReturnRequestRef.current !== returnToPhotoRequest)
      ) {
        if (returnToPhotoFocusFrameRef.current) {
          cancelAnimationFrame(returnToPhotoFocusFrameRef.current);
          returnToPhotoFocusFrameRef.current = 0;
        }
        pendingReturnFocusIdRef.current = null;
        returnToPhotoAutoScrollRef.current = false;
        pendingReturnToPhotoRequestRef.current =
          returnToPhotoId === null ? null : returnToPhotoRequest;
      }

      if (returnToPhotoId === null) {
        if (returnToPhotoFrameRef.current) {
          cancelAnimationFrame(returnToPhotoFrameRef.current);
          returnToPhotoFrameRef.current = 0;
        }
        if (returnToPhotoFocusFrameRef.current) {
          cancelAnimationFrame(returnToPhotoFocusFrameRef.current);
          returnToPhotoFocusFrameRef.current = 0;
        }
        pendingReturnToPhotoRequestRef.current = null;
        pendingReturnFocusIdRef.current = null;
        returnToPhotoAutoScrollRef.current = false;
      }

      if (positions.length === 0) {
        return;
      }
      const el = scrollRef.current;
      if (!el || prevRouteKey !== routeKey) {
        if (prevRouteKey !== routeKey) {
          reflowAnchorRef.current = null;
          pendingReturnToPhotoRequestRef.current = null;
          pendingReturnFocusIdRef.current = null;
          if (returnToPhotoFrameRef.current) {
            cancelAnimationFrame(returnToPhotoFrameRef.current);
            returnToPhotoFrameRef.current = 0;
          }
          if (returnToPhotoFocusFrameRef.current) {
            cancelAnimationFrame(returnToPhotoFocusFrameRef.current);
            returnToPhotoFocusFrameRef.current = 0;
          }
        }
        return;
      }

      if (
        plannedScrollTop !== null &&
        hasMatchingLayoutWidth(el, containerWidth)
      ) {
        const memberRect = photoFocusPending
          ? photoFocusRequest?.targetRect
          : null;
        if (memberRect?.innerScrollTop !== undefined && photoFocusRequest) {
          const inner = el.querySelector<HTMLElement>(
            `[data-sequence-tray-id="${-photoFocusRequest.photoId}"] [data-sequence-virtual-scroll]`
          );
          if (inner) {
            inner.scrollTop = memberRect.innerScrollTop;
          }
        }
        el.scrollTop = plannedScrollTop;
        // Keep one ID and screen offset through a continuous resize, even when
        // its column changes. User scrolling or explicit navigation releases it.
        reflowAnchorRef.current = pendingReflowAnchor
          ? { ...pendingReflowAnchor, expiresAt: Date.now() + 800 }
          : null;
        reflowScrollTopRef.current = el.scrollTop;
        prevScrollYRef.current = el.scrollTop;
        scrollTopStateRef.current = el.scrollTop;
        setScrollTop(el.scrollTop);
        scrollOverscanMultiplierRef.current = 1;
        scrollVelocityRef.current = 0;
        setScrollVelocity(0);
        syncScrollMetrics(el);
        updateScrollbarThumbPosition(el);
        onScrollTopChange?.(el.scrollTop);
        if (scrollRestorePending && scrollRestoreRequest) {
          completedScrollRestoreRef.current = scrollRestoreRequest.id;
          onScrollRestored?.(scrollRestoreRequest.id);
        }
      }

      if (
        pendingReturnToPhotoRequestRef.current === returnToPhotoRequest &&
        returnToPhotoId !== null &&
        returnToPhotoRequest > 0 &&
        positions.length > 0
      ) {
        if (returnToPhotoFrameRef.current) {
          cancelAnimationFrame(returnToPhotoFrameRef.current);
        }
        returnToPhotoFrameRef.current = requestAnimationFrame(() => {
          returnToPhotoFrameRef.current = 0;
          const el = scrollRef.current;
          // A parent can resize before ResizeObserver supplies the new width.
          // Keep the request pending until positions describe that final surface.
          if (el && !hasMatchingLayoutWidth(el, containerWidth)) {
            return;
          }
          const targetId = latestReturnToPhotoIdRef.current;
          const targetPositions = latestPositionsRef.current;
          const targetIndex =
            targetId === null
              ? undefined
              : latestIdToIndexMapRef.current.get(targetId);
          if (
            !el ||
            targetId === null ||
            targetIndex === undefined ||
            !targetPositions[targetIndex]
          ) {
            pendingReturnToPhotoRequestRef.current = null;
            return;
          }

          const position = targetPositions[targetIndex];
          // The tray may be taller than the viewport. If it is already mounted
          // in view, let its member locator reveal the frame without first
          // jumping back to the tray header.
          const memberContainerVisible =
            returnToMemberId !== null &&
            targetId < 0 &&
            position.top + position.height > el.scrollTop &&
            position.top < el.scrollTop + el.clientHeight - topInset;
          const nextScrollTop = memberContainerVisible
            ? null
            : getMasonryReturnScrollTop({
                cardHeight: position.height,
                cardTop: position.top,
                clientHeight: el.clientHeight,
                paddingTop,
                scrollTop: el.scrollTop,
                topInset,
              });
          if (nextScrollTop !== null) {
            returnToPhotoAutoScrollRef.current = true;
            el.scrollTop = nextScrollTop;
            requestAnimationFrame(() => {
              returnToPhotoAutoScrollRef.current = false;
            });
            prevScrollYRef.current = el.scrollTop;
            scrollTopStateRef.current = el.scrollTop;
            setScrollTop(el.scrollTop);
          }
          pendingReturnFocusIdRef.current = targetId;
          pendingReturnToPhotoRequestRef.current = null;

          const focusReturnCard = (attempt: number) => {
            returnToPhotoFocusFrameRef.current = requestAnimationFrame(() => {
              returnToPhotoFocusFrameRef.current = 0;
              const card = Array.from(
                scrollRef.current?.querySelectorAll<HTMLElement>(
                  '[data-photo-id][role="option"], [data-photo-id][role="button"], [data-sequence-tray-id]'
                ) ?? []
              ).find((element) =>
                targetId < 0
                  ? element.dataset.sequenceTrayId === String(-targetId)
                  : element.dataset.photoId === String(targetId)
              );
              if (card) {
                if (targetId >= 0) {
                  card.focus({ preventScroll: true });
                }
                pendingReturnFocusIdRef.current = null;
                completedReturnRequestRef.current = returnToPhotoRequest;
                onReturnLocatedRef.current?.(returnToPhotoRequest);
              } else if (attempt < 2) {
                focusReturnCard(attempt + 1);
              } else {
                pendingReturnFocusIdRef.current = null;
              }
            });
          };
          focusReturnCard(0);
        });
        return;
      }
    }, [
      cancelPhotoFocus,
      columnCount,
      gap,
      gridRef,
      items,
      onScrollRestored,
      onScrollTopChange,
      paddingTop,
      pendingReflowAnchor,
      photoFocusRequest,
      photoFocusPending,
      plannedScrollTop,
      positions,
      scrollRestorePending,
      scrollRestoreRequest,
      scrollToAlignment,
      scrollToId,
      returnToPhotoId,
      returnToMemberId,
      returnToPhotoRequest,
      routeKey,
      containerWidth,
      topInset,
      syncScrollMetrics,
      updateScrollbarThumbPosition,
    ]);

    useLayoutEffect(() => {
      if (
        !(
          photoFocusPending &&
          photoFocusRequest &&
          restoreReady &&
          hasInitialPositionedRef.current
        ) ||
        plannedScrollTop === null ||
        cancelledPhotoFocusRef.current === photoFocusRequest.id ||
        photoFocusRequest.targetRect === null
      ) {
        return;
      }
      // Keep the click alive until ResizeObserver and the DOM describe the
      // same surface. A subsequent layout restarts these two stable frames.
      let stableFrames = 0;
      const settle = () => {
        const el = scrollRef.current;
        if (
          !el ||
          latestPhotoFocusRef.current?.id !== photoFocusRequest.id ||
          cancelledPhotoFocusRef.current === photoFocusRequest.id
        ) {
          photoFocusFrameRef.current = 0;
          return;
        }
        const stable =
          hasMatchingLayoutWidth(el, containerWidth) &&
          el.clientHeight === effectiveViewportHeight &&
          (!photoFocusRequest.targetRect ||
            Math.abs(
              photoFocusRequest.targetRect.layoutWidth -
                (positions[idToIndexMap.get(photoFocusRequest.photoId) ?? -1]
                  ?.width ?? 0)
            ) <= 1) &&
          Math.abs(el.scrollTop - plannedScrollTop) <= 1;
        stableFrames = stable ? stableFrames + 1 : 0;
        if (stableFrames >= 2) {
          completedPhotoFocusRef.current = photoFocusRequest.id;
          completedPhotoFocusRectRef.current = photoFocusRequest.targetRect;
          photoFocusFrameRef.current = 0;
          onPhotoFocusSettledRef.current?.(photoFocusRequest.id);
          return;
        }
        photoFocusFrameRef.current = requestAnimationFrame(settle);
      };
      photoFocusFrameRef.current = requestAnimationFrame(settle);
      return () => {
        cancelAnimationFrame(photoFocusFrameRef.current);
        photoFocusFrameRef.current = 0;
      };
    }, [
      containerWidth,
      effectiveViewportHeight,
      hasInitialPositionedRef,
      photoFocusPending,
      photoFocusRequest,
      plannedScrollTop,
      restoreReady,
      positions,
      idToIndexMap,
    ]);

    useEffect(() => {
      return () => {
        if (returnToPhotoFrameRef.current) {
          cancelAnimationFrame(returnToPhotoFrameRef.current);
          returnToPhotoFrameRef.current = 0;
        }
        if (returnToPhotoFocusFrameRef.current) {
          cancelAnimationFrame(returnToPhotoFocusFrameRef.current);
          returnToPhotoFocusFrameRef.current = 0;
        }
      };
    }, []);

    const { visibleHeaders, visibleItems: windowItems } =
      useMasonryVirtualWindow({
        columnCount,
        headerPositions,
        overscan,
        positions,
        scrollTop: effectiveScrollTop,
        velocity: scrollVelocity,
        visibilityIndex,
        viewportHeight: effectiveViewportHeight,
      });
    const visibleItems = useMemo(() => {
      const index =
        photoFocusPending && photoFocusRequest?.targetRect !== undefined
          ? idToIndexMap.get(photoFocusRequest.photoId)
          : undefined;
      const position = index === undefined ? undefined : positions[index];
      if (
        index === undefined ||
        !position ||
        windowItems.some((item) => item.index === index)
      ) {
        return windowItems;
      }
      return [
        ...windowItems,
        {
          index,
          style: {
            position: "absolute" as const,
            top: position.top,
            left: position.left,
            width: position.width,
            height: position.height,
          },
        },
      ].sort((a, b) => a.index - b.index);
    }, [
      windowItems,
      photoFocusPending,
      photoFocusRequest,
      idToIndexMap,
      positions,
    ]);

    useEffect(() => {
      const photos = visibleItems.map(({ index }) => items[index]);
      const refresh = () => {
        ensureGalleryPhotos(photos, true).catch(() => undefined);
      };
      refresh();
      const keepVisible = setInterval(refresh, 60_000);
      let renderImageCount = 0;
      for (const { style } of visibleItems) {
        if (
          shouldRenderItemImage(
            style,
            effectiveScrollTop,
            effectiveViewportHeight
          )
        ) {
          renderImageCount++;
        }
      }
      recordGalleryPerf("masonryImageWindowCandidates", renderImageCount);
      return () => clearInterval(keepVisible);
    }, [visibleItems, effectiveScrollTop, effectiveViewportHeight, items]);

    // Keep an already displayed image until its virtual DOM card leaves the
    // window. Width reflow must not briefly replace it with a placeholder.
    const retainedImagesRef = useRef(new Set<number>());
    const requestedImageIds = getMasonryImageRequests(
      visibleItems.map(({ index, style }) => ({ id: items[index].id, style })),
      effectiveScrollTop,
      effectiveViewportHeight,
      scrollDirectionRef.current,
      scrollVelocity
    );
    const renderedImageIds = new Set<number>();
    for (const { index } of visibleItems) {
      const id = items[index].id;
      if (
        (photoFocusPending &&
          photoFocusRequest?.targetRect !== undefined &&
          id === photoFocusRequest.photoId) ||
        retainedImagesRef.current.has(id) ||
        requestedImageIds.has(id)
      ) {
        renderedImageIds.add(id);
      }
    }
    useLayoutEffect(() => {
      retainedImagesRef.current = renderedImageIds;
      recordGalleryPerf("masonryImageItems", requestedImageIds.size);
    });

    const scrollToTop = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        const el = scrollRef.current;
        if (!el) {
          return;
        }
        const distance = el.scrollTop;
        onBackToTop?.();
        cancelPhotoFocus();
        el.scrollTo({
          top: 0,
          behavior:
            isReducedMotionEnabled() || distance > el.clientHeight * 4
              ? "auto"
              : "smooth",
        });
      },
      [cancelPhotoFocus, onBackToTop]
    );

    const layoutReady = containerWidth > 0 && columnCount > 0;
    useLayoutEffect(() => {
      const el = scrollRef.current;
      if (!el) {
        return;
      }
      syncScrollMetrics(el);
      updateScrollbarThumbPosition(el);
    }, [syncScrollMetrics, updateScrollbarThumbPosition]);

    useLayoutEffect(() => {
      const el = scrollRef.current;
      if (el) {
        updateScrollbarThumbPosition(el);
      }
    }, [updateScrollbarThumbPosition]);

    const bottomSkeletons = useMemo(() => {
      const skeletonAspects = [3 / 4, 4 / 3, 1 / 1, 3 / 2, 2 / 3];
      if (!(isLoadingMore && layoutReady) || positions.length === 0) {
        return [];
      }
      const colBottoms = new Array(columnCount).fill(0);
      for (
        let i = Math.max(0, positions.length - columnCount * 3);
        i < positions.length;
        i++
      ) {
        const pos = positions[i];
        const colIdx = Math.round(
          pos.left / ((containerWidth - (columnCount - 1) * gap) / columnCount)
        );
        const c = Math.max(0, Math.min(columnCount - 1, colIdx));
        if (pos.top + pos.height > colBottoms[c]) {
          colBottoms[c] = pos.top + pos.height;
        }
      }
      const baseTop = Math.max(...colBottoms) + gap;
      const colWidth = (containerWidth - (columnCount - 1) * gap) / columnCount;
      return Array.from({ length: columnCount }, (_, i) => {
        const skelHeight =
          colWidth / skeletonAspects[i % skeletonAspects.length];
        return {
          index: i,
          style: {
            position: "absolute" as const,
            top: baseTop,
            left: i * (colWidth + gap),
            width: colWidth,
            height: skelHeight,
          },
        };
      });
    }, [
      isLoadingMore,
      layoutReady,
      positions,
      columnCount,
      containerWidth,
      gap,
    ]);

    const scrollbarTrackHeight = Math.max(0, viewportHeight - topInset);
    const scrollbarThumbHeight =
      scrollHeight > viewportHeight && scrollbarTrackHeight > 0
        ? Math.min(
            scrollbarTrackHeight,
            Math.max(
              MIN_SCROLLBAR_THUMB_HEIGHT,
              (scrollbarTrackHeight * viewportHeight) / scrollHeight
            )
          )
        : 0;
    const scrollbarTravel = Math.max(
      0,
      scrollbarTrackHeight - scrollbarThumbHeight
    );
    const showCustomScrollbar =
      scrollbarThumbHeight > 0 && scrollHeight > viewportHeight;

    const handleScrollbarThumbPointerDown = useCallback(
      (event: React.PointerEvent<HTMLDivElement>) => {
        const el = scrollRef.current;
        if (!el || scrollbarTravel <= 0) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        scrollbarDragRef.current = {
          pointerId: event.pointerId,
          startScrollTop: el.scrollTop,
          startY: event.clientY,
          travel: scrollbarTravel,
        };
      },
      [scrollbarTravel]
    );

    const handleScrollbarThumbPointerMove = useCallback(
      (event: React.PointerEvent<HTMLDivElement>) => {
        const drag = scrollbarDragRef.current;
        const el = scrollRef.current;
        if (!drag || drag.pointerId !== event.pointerId || !el) {
          return;
        }
        event.preventDefault();
        const scrollRange = Math.max(0, el.scrollHeight - el.clientHeight);
        const nextScrollTop = Math.max(
          0,
          Math.min(
            scrollRange,
            drag.startScrollTop +
              ((event.clientY - drag.startY) / drag.travel) * scrollRange
          )
        );
        el.scrollTop = nextScrollTop;
      },
      []
    );

    const finishScrollbarDrag = useCallback(
      (event: React.PointerEvent<HTMLDivElement>) => {
        if (scrollbarDragRef.current?.pointerId === event.pointerId) {
          scrollbarDragRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }
      },
      []
    );

    return (
      <div className="relative" style={{ height: "100%", overflow: "hidden" }}>
        <div
          className={className}
          data-masonry-scroll=""
          onMouseDown={handleMarqueeStart}
          ref={scrollRef}
          style={
            {
              height: "100%",
              overflowX: "hidden",
              overflowY: "auto",
              overflowAnchor: "none",
              paddingTop: topInset > 0 ? topInset + 8 : undefined,
            } as React.CSSProperties
          }
        >
          {layoutReady && (
            <div
              style={{
                position: "relative",
                height: totalHeight,
                width: "100%",
              }}
            >
              {showGroupHeaders &&
                visibleHeaders.map((h) => (
                  <div
                    className="flex cursor-pointer items-end px-1 pb-1 font-medium text-[12px] text-muted-foreground"
                    key={h.label}
                    onClick={() => {
                      scrollRef.current?.scrollTo({
                        top: Math.max(0, h.top - 16),
                        behavior: isReducedMotionEnabled() ? "auto" : "smooth",
                      });
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                    style={{
                      position: "absolute",
                      top: h.top,
                      left: 0,
                      width: "100%",
                      height: HEADER_HEIGHT,
                    }}
                  >
                    {h.label}
                  </div>
                ))}
              {visibleItems.map(({ index, style }) => (
                <div key={items[index].id} style={style}>
                  {renderItem(items[index], index, style, {
                    imageIdle: !isScrolling,
                    requestImage: requestedImageIds.has(items[index].id),
                    imageWidth: Number(style.width),
                    imageHeight: Number(style.height),
                    imageVisible:
                      Number(style.top) + Number(style.height) >=
                        effectiveScrollTop &&
                      Number(style.top) <=
                        effectiveScrollTop + effectiveViewportHeight,
                    imagePriority:
                      Number(style.top) + Number(style.height) >=
                        effectiveScrollTop &&
                      Number(style.top) <=
                        effectiveScrollTop + effectiveViewportHeight
                        ? 0
                        : 1,
                    renderImage:
                      (photoFocusPending &&
                        photoFocusRequest?.targetRect !== undefined &&
                        items[index].id === photoFocusRequest.photoId) ||
                      renderedImageIds.has(items[index].id),
                  })}
                </div>
              ))}
              {bottomSkeletons.map((sk) => (
                <div key={`skel-${sk.index}`} style={sk.style}>
                  <div
                    className="w-full animate-shimmer rounded-[8px] bg-muted"
                    style={{ height: sk.style.height }}
                  />
                </div>
              ))}
              {onEndReached && totalHeight > 0 && (
                <div
                  ref={sentinelRef}
                  style={{
                    position: "absolute",
                    top: Math.max(0, totalHeight - 200),
                    left: 0,
                    width: 1,
                    height: 1,
                    pointerEvents: "none",
                  }}
                />
              )}
              {marquee && (
                <div
                  className="pointer-events-none absolute z-30 rounded-[2px] border border-primary/60 bg-primary/10"
                  style={{
                    left: Math.min(marquee.startX, marquee.x),
                    top: Math.min(marquee.startY, marquee.y),
                    width: Math.abs(marquee.x - marquee.startX),
                    height: Math.abs(marquee.y - marquee.startY),
                  }}
                />
              )}
            </div>
          )}
        </div>
        {showCustomScrollbar && (
          <div
            aria-hidden="true"
            className="masonry-scrollbar"
            style={{ top: topInset }}
          >
            <div className="masonry-scrollbar-track" />
            <div
              className="masonry-scrollbar-thumb"
              onPointerCancel={finishScrollbarDrag}
              onPointerDown={handleScrollbarThumbPointerDown}
              onPointerMove={handleScrollbarThumbPointerMove}
              onPointerUp={finishScrollbarDrag}
              ref={scrollbarThumbRef}
            />
          </div>
        )}
        <MasonryBackToTop
          label={t("backToTop")}
          onClick={scrollToTop}
          selectionActive={selectionActive}
          show={showScrollTop}
        />
        {isScrolling && currentTimeLabel && headerPositions.length > 0 && (
          <div
            className="glass-surface pointer-events-none absolute right-4 z-20 rounded-[6px] px-3 py-1.5 font-medium text-[12px] text-foreground shadow-lg ring-1 ring-border"
            style={{ top: topInset + 8 }}
          >
            {currentTimeLabel}
          </div>
        )}
      </div>
    );
  }),
  (prevProps, nextProps) =>
    prevProps.items === nextProps.items &&
    prevProps.groupHeaders === nextProps.groupHeaders &&
    prevProps.containerWidth === nextProps.containerWidth &&
    prevProps.columnCount === nextProps.columnCount &&
    prevProps.gap === nextProps.gap &&
    prevProps.isLoadingMore === nextProps.isLoadingMore &&
    prevProps.hasMore === nextProps.hasMore &&
    prevProps.isPlaceholderData === nextProps.isPlaceholderData &&
    prevProps.itemStateVersion === nextProps.itemStateVersion &&
    prevProps.selectionActive === nextProps.selectionActive &&
    prevProps.onBackToTop === nextProps.onBackToTop &&
    prevProps.photoFocusRequest === nextProps.photoFocusRequest &&
    prevProps.onPhotoFocusSettled === nextProps.onPhotoFocusSettled &&
    prevProps.scrollToId === nextProps.scrollToId &&
    prevProps.returnToPhotoId === nextProps.returnToPhotoId &&
    prevProps.returnToMemberId === nextProps.returnToMemberId &&
    prevProps.returnToPhotoRequest === nextProps.returnToPhotoRequest &&
    prevProps.scrollRestoreRequest === nextProps.scrollRestoreRequest &&
    prevProps.onScrollRestored === nextProps.onScrollRestored &&
    prevProps.onScrollTopChange === nextProps.onScrollTopChange &&
    prevProps.onRestoreSettled === nextProps.onRestoreSettled &&
    prevProps.onReturnLocated === nextProps.onReturnLocated &&
    prevProps.topInset === nextProps.topInset &&
    prevProps.showGroupHeaders === nextProps.showGroupHeaders &&
    prevProps.routeKey === nextProps.routeKey &&
    prevProps.restoreGateReady === nextProps.restoreGateReady
);
