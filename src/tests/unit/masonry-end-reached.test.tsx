import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

describe("useMasonryEndReached", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T10:00:00Z"));
  });

  it("uses shorter debounce windows for fast scrolling", () => {
    expect(getEndReachedDebounceMs(0)).toBe(400);
    expect(getEndReachedDebounceMs(60)).toBe(200);
    expect(getEndReachedDebounceMs(180)).toBe(100);
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
});
