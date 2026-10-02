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
  useMasonryLayout,
} from "@/hooks/useMasonryLayout";
import { useMasonryMarquee } from "@/hooks/useMasonryMarquee";
import {
  getVelocityOverscanMultiplier,
  HEADER_HEIGHT,
  useMasonryVirtualWindow,
} from "@/hooks/useMasonryVirtualWindow";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
import { recordGalleryPerf } from "@/utils/gallery-perf";
import { getMasonryReflowScrollTop } from "@/utils/masonry-reflow";

export type { GroupHeaderInput as GroupHeader, MasonryGridHandle };

import { getReturnScrollTop } from "@/utils/gallery-return";

const SCROLL_TOP_EPSILON = 0.5;
const SCROLL_RENDER_STEP_PX = 96;
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
  viewportHeight: number
): boolean {
  if (viewportHeight <= 0) {
    return true;
  }
  const itemTop = Number(style.top) || 0;
  const itemHeight = Number(style.height) || 0;
  const imageTop =
    scrollTop - viewportHeight * IMAGE_RENDER_OVERSCAN_VIEWPORTS_BEFORE;
  const imageBottom =
    scrollTop + viewportHeight * IMAGE_RENDER_OVERSCAN_VIEWPORTS_AFTER;
  return itemTop + itemHeight >= imageTop && itemTop <= imageBottom;
}

export function shouldUpdateScrollRenderTop(
  currentScrollTop: number,
  renderedScrollTop: number
): boolean {
  return (
    Math.abs(currentScrollTop - renderedScrollTop) >= SCROLL_RENDER_STEP_PX
  );
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
  onEndReached?: () => void;
  onMarqueeSelect?: (ids: Set<number>) => void;
  onRestoreSettled?: (routeKey: string) => void;
  onReturnLocated?: (request: number) => void;
  onScrollTopChange?: (scrollTop: number) => void;
  overscan?: number;
  renderItem: (
    item: any,
    index: number,
    style: React.CSSProperties,
    options: { renderImage: boolean }
  ) => ReactNode;
  restoreGateReady?: boolean;
  returnToMemberId?: number | null;
  returnToPhotoId?: number | null;
  returnToPhotoRequest?: number;
  routeKey: string;
  scrollToAlignment?: "center" | "start";
  scrollToId?: number | null;
  selectionActive?: boolean;
  showGroupHeaders?: boolean;
  topInset?: number;
}

export const MasonryGrid = memo(
  forwardRef<MasonryGridHandle, MasonryGridProps>(function MasonryGrid(
    {
      items,
      containerWidth,
      columnCount,
      gap,
      groupHeaders,
      overscan = 5,
      renderItem,
      onEndReached,
      hasMore = false,
      isLoadingMore = false,
      onMarqueeSelect,
      onRestoreSettled,
      onReturnLocated,
      onScrollTopChange,
      scrollToAlignment = "center",
      scrollToId,
      className,
      selectionActive = false,
      showGroupHeaders = true,
      returnToPhotoId = null,
      returnToMemberId = null,
      returnToPhotoRequest = 0,
      routeKey,
      restoreGateReady = true,
      isPlaceholderData = false,
      topInset = 0,
    }: MasonryGridProps,
    ref
  ) {
    const { t } = useTranslation();
    const scrollRef = useRef<HTMLDivElement>(null);
    const sentinelRef = useRef<HTMLDivElement>(null);
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
    const reflowScrollTopRef = useRef<number | null>(null);
    const returnToPhotoAutoScrollRef = useRef(false);
    const returnToPhotoFocusFrameRef = useRef<number>(0);
    const routeForceUnlockRef = useRef<(() => void) | null>(null);
    const scrollbarThumbRef = useRef<HTMLDivElement>(null);
    const scrollbarDragRef = useRef<{
      pointerId: number;
      startY: number;
      startScrollTop: number;
      travel: number;
    } | null>(null);

    const { positions, totalHeight, headerPositions, visibilityIndex } =
      useMasonryLayout(
        items,
        containerWidth,
        columnCount,
        gap,
        groupHeaders,
        routeKey,
        showGroupHeaders
      );

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
      reflowScrollTopRef.current = null;
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

        const dy = Math.abs(el.scrollTop - prevScrollYRef.current);
        onScrollTopChange?.(el.scrollTop);
        prevScrollYRef.current = el.scrollTop;
        const nextOverscanMultiplier = getVelocityOverscanMultiplier(dy);
        if (nextOverscanMultiplier !== scrollOverscanMultiplierRef.current) {
          scrollOverscanMultiplierRef.current = nextOverscanMultiplier;
          scrollVelocityRef.current = dy;
          setScrollVelocity(dy);
        }

        if (
          shouldUpdateScrollRenderTop(el.scrollTop, scrollTopStateRef.current)
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
        }, 600);

        const headers = headerPositionsRef.current;
        let nextLabel = "";
        if (headers.length > 0) {
          for (let i = headers.length - 1; i >= 0; i--) {
            if (headers[i].top <= el.scrollTop + 100) {
              nextLabel = headers[i].label;
              break;
            }
          }
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
    const prevReturnToPhotoRequestRef = useRef(0);
    const prevReturnToPhotoIdRef = useRef(returnToPhotoId);
    const completedReturnRequestRef = useRef(0);
    const pendingReturnToPhotoRequestRef = useRef<number | null>(null);
    const prevRouteKeyRef = useRef(routeKey);
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
    const clampScrollTop = (value: number) =>
      Math.max(
        0,
        Math.min(
          value,
          totalHeight + paddingTop + paddingBottom - effectiveViewportHeight
        )
      );
    const plannedScrollTop = (() => {
      if (
        !scrollElement ||
        prevRouteKeyRef.current !== routeKey ||
        !restoreReady ||
        !hasInitialPositionedRef.current
      ) {
        return null;
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
        reflowScrollTop = clampScrollTop(
          enforced && enforcedPosition
            ? enforcedPosition.top + enforcedPosition.height * enforced.ratio
            : getMasonryReflowScrollTop({
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
      if (
        scrollToId != null &&
        (scrollToId !== prevScrollToIdRef.current ||
          scrollToAlignment !== prevScrollToAlignmentRef.current)
      ) {
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
        el.scrollTop = plannedScrollTop;
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
      columnCount,
      gap,
      items,
      onScrollTopChange,
      paddingTop,
      plannedScrollTop,
      positions,
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

    const { visibleHeaders, visibleItems } = useMasonryVirtualWindow({
      columnCount,
      headerPositions,
      overscan,
      positions,
      scrollTop: effectiveScrollTop,
      velocity: scrollVelocity,
      visibilityIndex,
      viewportHeight: effectiveViewportHeight,
    });

    useEffect(() => {
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
      recordGalleryPerf("masonryImageItems", renderImageCount);
    }, [visibleItems, effectiveScrollTop, effectiveViewportHeight]);

    const scrollToTop = useCallback((e: React.MouseEvent) => {
      e.stopPropagation();
      const el = scrollRef.current;
      if (!el) {
        return;
      }
      const distance = el.scrollTop;
      el.scrollTo({
        top: 0,
        behavior:
          isReducedMotionEnabled() || distance > el.clientHeight * 4
            ? "auto"
            : "smooth",
      });
    }, []);

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
                    renderImage: shouldRenderItemImage(
                      style,
                      effectiveScrollTop,
                      effectiveViewportHeight
                    ),
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
    prevProps.scrollToId === nextProps.scrollToId &&
    prevProps.returnToPhotoId === nextProps.returnToPhotoId &&
    prevProps.returnToMemberId === nextProps.returnToMemberId &&
    prevProps.returnToPhotoRequest === nextProps.returnToPhotoRequest &&
    prevProps.onScrollTopChange === nextProps.onScrollTopChange &&
    prevProps.onRestoreSettled === nextProps.onRestoreSettled &&
    prevProps.onReturnLocated === nextProps.onReturnLocated &&
    prevProps.topInset === nextProps.topInset &&
    prevProps.showGroupHeaders === nextProps.showGroupHeaders &&
    prevProps.routeKey === nextProps.routeKey &&
    prevProps.restoreGateReady === nextProps.restoreGateReady
);
