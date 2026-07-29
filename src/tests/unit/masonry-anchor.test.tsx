import { act, renderHook } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMasonryAnchor } from "@/hooks/useMasonryAnchor";
import type { MasonryItem } from "@/hooks/useMasonryLayout";
import { buildMasonryVisibilityIndex } from "@/utils/masonry-utils";

function createScrollElement() {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollTop", { value: 0, writable: true });
  Object.defineProperty(el, "clientHeight", { value: 300, writable: true });
  return el;
}

const positions: MasonryItem[] = [
  { top: 0, left: 0, width: 100, height: 100 },
  { top: 120, left: 0, width: 100, height: 200 },
];
const items = [
  { id: 10, width: 100, height: 100 },
  { id: 20, width: 100, height: 200 },
];

describe("useMasonryAnchor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T10:00:00Z"));
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      setTimeout(() => cb(performance.now()), 0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  });

  it("captures the current visible anchor from positions", () => {
    const el = createScrollElement();
    el.scrollTop = 170;
    const forwardedRef = createRef<any>();

    const { result } = renderHook(() =>
      useMasonryAnchor({
        containerWidth: 300,
        forwardedRef,
        forceUnlockRef: { current: null },
        idToIndexMap: new Map(items.map((item, i) => [item.id, i])),
        items,
        positions,
        scrollRef: { current: el },
        visibilityIndex: buildMasonryVisibilityIndex(positions),
      })
    );

    expect(result.current.getCurrentAnchor()).toEqual({
      itemId: 20,
      offsetFromTop: 50,
      offsetRatio: 0.25,
      estimatedGlobalIndex: 1,
    });
  });

  it("captures a tall earlier card that still crosses the viewport", () => {
    const el = createScrollElement();
    el.scrollTop = 400;
    const forwardedRef = createRef<any>();
    const tallPositions: MasonryItem[] = [
      { top: 0, left: 0, width: 100, height: 500 },
      { top: 0, left: 110, width: 100, height: 100 },
      { top: 110, left: 110, width: 100, height: 100 },
      { top: 220, left: 110, width: 100, height: 100 },
      { top: 330, left: 110, width: 100, height: 100 },
    ];
    const tallItems = tallPositions.map((position, index) => ({
      ...position,
      id: index + 1,
    }));

    const { result } = renderHook(() =>
      useMasonryAnchor({
        containerWidth: 300,
        forwardedRef,
        forceUnlockRef: { current: null },
        idToIndexMap: new Map(tallItems.map((item, i) => [item.id, i])),
        items: tallItems,
        positions: tallPositions,
        scrollRef: { current: el },
        visibilityIndex: buildMasonryVisibilityIndex(tallPositions),
      })
    );

    expect(result.current.getCurrentAnchor()).toMatchObject({
      itemId: 1,
      offsetFromTop: 400,
      offsetRatio: 0.8,
      estimatedGlobalIndex: 0,
    });
  });

  it("scrollToItem enforces an anchor position until user intervention", () => {
    const el = createScrollElement();
    const forceUnlock = vi.fn();
    const forwardedRef = createRef<any>();

    renderHook(() =>
      useMasonryAnchor({
        containerWidth: 300,
        forwardedRef,
        forceUnlockRef: { current: forceUnlock },
        idToIndexMap: new Map(items.map((item, i) => [item.id, i])),
        items,
        positions,
        scrollRef: { current: el },
        visibilityIndex: buildMasonryVisibilityIndex(positions),
      })
    );

    act(() => {
      forwardedRef.current.scrollToItem(20, 0.5);
    });
    expect(el.scrollTop).toBe(220);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    act(() => {
      el.dispatchEvent(new WheelEvent("wheel"));
    });
    expect(forceUnlock).toHaveBeenCalled();
  });
});
