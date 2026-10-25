import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getEndReachedDebounceMs,
  useMasonryEndReached,
} from "@/hooks/useMasonryEndReached";

function createScrollRef() {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollTop", { value: 1500, writable: true });
  Object.defineProperty(el, "clientHeight", { value: 600, writable: true });
  Object.defineProperty(el, "scrollHeight", { value: 2200, writable: true });
  return { current: el };
}

function setScrollHeight(element: HTMLDivElement, height: number) {
  Object.defineProperty(element, "scrollHeight", { value: height });
}

describe("useMasonryEndReached", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uses shorter debounce windows for fast scrolling", () => {
    expect(getEndReachedDebounceMs(0)).toBe(400);
    expect(getEndReachedDebounceMs(3.6)).toBe(200);
    expect(getEndReachedDebounceMs(10.8)).toBe(100);
  });

  it("does not trigger without hasMore", () => {
    const onEndReached = vi.fn();
    const { result } = renderHook(() =>
      useMasonryEndReached({
        hasMore: false,
        isLoadingMore: false,
        onEndReached,
        scrollRef: createScrollRef(),
        sentinelRef: { current: null },
        totalHeight: 2200,
      })
    );

    act(() => result.current.triggerEndReached());
    expect(onEndReached).not.toHaveBeenCalled();
  });

  it("does not trigger while loading", () => {
    const onEndReached = vi.fn();
    const { result } = renderHook(() =>
      useMasonryEndReached({
        hasMore: true,
        isLoadingMore: true,
        onEndReached,
        scrollRef: createScrollRef(),
        sentinelRef: { current: null },
        totalHeight: 2200,
      })
    );

    act(() => result.current.triggerEndReached());
    expect(onEndReached).not.toHaveBeenCalled();
  });

  it("waits for committed geometry before checking the initial page", () => {
    const onEndReached = vi.fn();
    const scrollRef = createScrollRef();
    const { rerender } = renderHook(
      ({ height }) =>
        useMasonryEndReached({
          hasMore: true,
          isLoadingMore: false,
          onEndReached,
          scrollRef,
          sentinelRef: { current: null },
          totalHeight: height,
        }),
      { initialProps: { height: 0 } }
    );
    expect(onEndReached).not.toHaveBeenCalled();
    rerender({ height: 2200 });
    expect(onEndReached).toHaveBeenCalledTimes(1);
  });

  it("locks repeated triggers and unlocks after loading completes", () => {
    const onEndReached = vi.fn();
    const scrollRef = createScrollRef();
    const { rerender, result } = renderHook(
      ({ isLoadingMore }: { isLoadingMore: boolean }) =>
        useMasonryEndReached({
          hasMore: true,
          isLoadingMore,
          onEndReached,
          scrollRef,
          sentinelRef: { current: null },
          totalHeight: 2200,
        }),
      { initialProps: { isLoadingMore: false } }
    );

    act(() => result.current.triggerEndReached());
    act(() => result.current.triggerEndReached());
    expect(onEndReached).toHaveBeenCalledTimes(1);

    rerender({ isLoadingMore: true });
    rerender({ isLoadingMore: false });
    act(() => {
      vi.advanceTimersByTime(401);
      result.current.triggerEndReached();
    });
    expect(onEndReached).toHaveBeenCalledTimes(2);
  });

  it("checks near-bottom distance before triggering", () => {
    const onEndReached = vi.fn();
    const scrollRef = createScrollRef();
    const { result } = renderHook(() =>
      useMasonryEndReached({
        hasMore: true,
        isLoadingMore: false,
        onEndReached,
        scrollRef,
        sentinelRef: { current: null },
        totalHeight: 2200,
      })
    );

    act(() => result.current.checkNearBottom(180));
    expect(onEndReached).toHaveBeenCalledTimes(1);
  });

  it("continues after a short page without another scroll or intersection", () => {
    const onEndReached = vi.fn();
    const scrollRef = createScrollRef();
    const { rerender } = renderHook(
      ({ loading, height }: { loading: boolean; height: number }) =>
        useMasonryEndReached({
          hasMore: true,
          isLoadingMore: loading,
          onEndReached,
          scrollRef,
          sentinelRef: { current: null },
          totalHeight: height,
        }),
      { initialProps: { loading: false, height: 2200 } }
    );
    expect(onEndReached).toHaveBeenCalledTimes(1);
    rerender({ loading: true, height: 2200 });
    setScrollHeight(scrollRef.current, 2800);
    rerender({ loading: false, height: 2800 });
    act(() => vi.advanceTimersByTime(401));
    expect(onEndReached).toHaveBeenCalledTimes(2);

    rerender({ loading: true, height: 2800 });
    setScrollHeight(scrollRef.current, 10_000);
    rerender({ loading: false, height: 10_000 });
    act(() => vi.advanceTimersByTime(1000));
    expect(onEndReached).toHaveBeenCalledTimes(2);
  });

  it("continues when a cached page commits without an intermediate loading render", () => {
    const onEndReached = vi.fn();
    const scrollRef = createScrollRef();
    const { rerender } = renderHook(
      ({ height }) =>
        useMasonryEndReached({
          hasMore: true,
          isLoadingMore: false,
          onEndReached,
          scrollRef,
          sentinelRef: { current: null },
          totalHeight: height,
        }),
      { initialProps: { height: 2200 } }
    );
    expect(onEndReached).toHaveBeenCalledTimes(1);
    setScrollHeight(scrollRef.current, 2800);
    rerender({ height: 2800 });
    act(() => vi.advanceTimersByTime(401));
    expect(onEndReached).toHaveBeenCalledTimes(2);
  });

  it("rechecks after the resize pause expires", () => {
    const onEndReached = vi.fn();
    const scrollRef = createScrollRef();
    setScrollHeight(scrollRef.current, 10_000);
    const { rerender } = renderHook(
      ({ width }: { width: number }) =>
        useMasonryEndReached({
          containerWidth: width,
          hasMore: true,
          isLoadingMore: false,
          onEndReached,
          scrollRef,
          sentinelRef: { current: null },
          totalHeight: 2200,
        }),
      { initialProps: { width: 1000 } }
    );
    setScrollHeight(scrollRef.current, 2200);
    rerender({ width: 700 });
    act(() => vi.advanceTimersByTime(499));
    expect(onEndReached).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onEndReached).toHaveBeenCalledTimes(1);
  });

  it("does not prefetch when the user moves away before the delayed check", () => {
    const onEndReached = vi.fn();
    const scrollRef = createScrollRef();
    const { rerender } = renderHook(
      ({ loading, height }: { loading: boolean; height: number }) =>
        useMasonryEndReached({
          hasMore: true,
          isLoadingMore: loading,
          onEndReached,
          scrollRef,
          sentinelRef: { current: null },
          totalHeight: height,
        }),
      { initialProps: { loading: false, height: 2200 } }
    );
    rerender({ loading: true, height: 2200 });
    rerender({ loading: false, height: 3500 });
    setScrollHeight(scrollRef.current, 3500);
    scrollRef.current.scrollTop = 0;
    act(() => vi.advanceTimersByTime(1000));
    expect(onEndReached).toHaveBeenCalledTimes(1);
  });

  it("does not repeatedly retry an unsuccessful page with unchanged geometry", () => {
    const onEndReached = vi.fn();
    const scrollRef = createScrollRef();
    const { rerender } = renderHook(
      ({ loading }: { loading: boolean }) =>
        useMasonryEndReached({
          hasMore: true,
          isLoadingMore: loading,
          onEndReached,
          scrollRef,
          sentinelRef: { current: null },
          totalHeight: 2200,
        }),
      { initialProps: { loading: false } }
    );
    rerender({ loading: true });
    rerender({ loading: false });
    act(() => vi.advanceTimersByTime(5000));
    expect(onEndReached).toHaveBeenCalledTimes(1);
  });

  it("keeps the observer when fetching changes the callback identity", () => {
    const onEndReached = vi.fn();
    const observe = vi.fn();
    const disconnect = vi.fn();
    const observer = vi.fn(function observeEnd() {
      return { observe, disconnect };
    });
    vi.stubGlobal("IntersectionObserver", observer);
    const scrollRef = createScrollRef();
    const sentinelRef = { current: document.createElement("div") };
    const { rerender } = renderHook(
      ({ loading }: { loading: boolean }) =>
        useMasonryEndReached({
          hasMore: true,
          isLoadingMore: loading,
          onEndReached: () => onEndReached(),
          scrollRef,
          sentinelRef,
          totalHeight: 2200,
        }),
      { initialProps: { loading: false } }
    );
    expect(onEndReached).toHaveBeenCalledTimes(1);
    rerender({ loading: true });
    rerender({ loading: false });
    act(() => vi.advanceTimersByTime(5000));
    expect(observer).toHaveBeenCalledTimes(1);
    expect(onEndReached).toHaveBeenCalledTimes(1);
  });

  it("cancels delayed checks when the gallery unmounts", () => {
    const onEndReached = vi.fn();
    const scrollRef = createScrollRef();
    setScrollHeight(scrollRef.current, 10_000);
    const { rerender, unmount } = renderHook(
      ({ width }: { width: number }) =>
        useMasonryEndReached({
          containerWidth: width,
          hasMore: true,
          isLoadingMore: false,
          onEndReached,
          scrollRef,
          sentinelRef: { current: null },
          totalHeight: 2200,
        }),
      { initialProps: { width: 1000 } }
    );
    setScrollHeight(scrollRef.current, 2200);
    rerender({ width: 700 });
    unmount();
    act(() => vi.advanceTimersByTime(1000));
    expect(onEndReached).not.toHaveBeenCalled();
  });

  it("ignores a delayed check after the last page is reached", () => {
    const onEndReached = vi.fn();
    const scrollRef = createScrollRef();
    const { rerender } = renderHook(
      ({ loading, more, height }) =>
        useMasonryEndReached({
          hasMore: more,
          isLoadingMore: loading,
          onEndReached,
          scrollRef,
          sentinelRef: { current: null },
          totalHeight: height,
        }),
      { initialProps: { loading: false, more: true, height: 2200 } }
    );
    rerender({ loading: true, more: true, height: 2200 });
    rerender({ loading: false, more: true, height: 2800 });
    rerender({ loading: false, more: false, height: 2800 });
    act(() => vi.advanceTimersByTime(1000));
    expect(onEndReached).toHaveBeenCalledTimes(1);
  });
});
