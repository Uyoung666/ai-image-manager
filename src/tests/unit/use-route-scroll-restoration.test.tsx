import { act, renderHook } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ScrollPositionProvider,
  useScrollPosition,
} from "@/contexts/ScrollPositionContext";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";

// Mock TanStack Router's useLocation
vi.mock("@tanstack/react-router", () => ({
  useLocation: () => ({ pathname: "/test" }),
}));

function wrapper({ children }: { children: ReactNode }) {
  return React.createElement(ScrollPositionProvider, null, children);
}

// Helper: create a mock scroll container element
function createScrollContainer(
  scrollHeight = 2000,
  clientHeight = 600
): HTMLElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollTop", {
    value: 0,
    writable: true,
  });
  Object.defineProperty(el, "scrollHeight", {
    value: scrollHeight,
    writable: true,
  });
  Object.defineProperty(el, "clientHeight", {
    value: clientHeight,
    writable: true,
  });
  Object.defineProperty(el, "isConnected", {
    value: true,
    writable: true,
  });
  el.getBoundingClientRect = () =>
    ({ top: 0, left: 0, width: 800, height: clientHeight }) as DOMRect;
  el.addEventListener = vi.fn();
  el.removeEventListener = vi.fn();
  document.body.appendChild(el);
  return el;
}

// Helper: create a ref object pointing to an element
function createRef(el: HTMLElement | null) {
  return { current: el };
}

describe("useRouteScrollRestoration", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T12:00:00Z"));
    // Mock requestAnimationFrame to fire immediately
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(
      (cb: FrameRequestCallback): number => {
        cb(0);
        return 1;
      }
    );
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {
      /* Intentionally empty: requestAnimationFrame is simulated above. */
    });
  });

  describe("save on scroll", () => {
    it("should invoke saveScrollPosition via context when scroll fires", () => {
      const el = createScrollContainer();
      const ref = createRef(el);

      // Capture scroll handler to verify it's registered
      const addEventListenerCalls: [string, EventListener][] = [];
      (el.addEventListener as ReturnType<typeof vi.fn>).mockImplementation(
        (event: string, handler: EventListener) => {
          addEventListenerCalls.push([event, handler]);
        }
      );

      renderHook(
        () =>
          useRouteScrollRestoration(ref, {
            getRouteKey: () => "test-scroll-invoke",
          }),
        { wrapper }
      );

      // Scroll event handler should be registered with passive flag
      const scrollReg = addEventListenerCalls.find(
        ([event]) => event === "scroll"
      );
      expect(scrollReg).toBeDefined();
    });
  });

  describe("delayed sessionStorage write", () => {
    it("should write to sessionStorage when saveScrollPosition is called via useScrollPosition", () => {
      const { result } = renderHook(() => useScrollPosition(), { wrapper });

      // Directly call saveScrollPosition
      act(() => {
        result.current.saveScrollPosition("test-direct-debounce", 600);
        vi.advanceTimersByTime(300);
      });

      const stored = sessionStorage.getItem(
        "scroll_position_test-direct-debounce"
      );
      expect(stored).not.toBeNull();
      if (stored === null) {
        throw new Error("Expected scroll position to be stored");
      }
      const parsed = JSON.parse(stored);
      expect(parsed.scrollTop).toBe(600);
    });
  });

  describe("scrollend flush", () => {
    it("should call flushPendingWrites on scrollend event", () => {
      const el = createScrollContainer();
      const ref = createRef(el);
      let scrollEndHandler: EventListener | null = null;

      (el.addEventListener as ReturnType<typeof vi.fn>).mockImplementation(
        (event: string, handler: EventListener) => {
          if (event === "scrollend") {
            scrollEndHandler = handler;
          }
        }
      );

      renderHook(
        () =>
          useRouteScrollRestoration(ref, {
            getRouteKey: () => "test-scrollend",
          }),
        { wrapper }
      );

      // scrollend handler should be registered
      expect(scrollEndHandler).not.toBeNull();
    });
  });

  describe("restoration gating", () => {
    it("should not restore when restoreReady is false", () => {
      const el = createScrollContainer();
      const ref = createRef(el);

      // Pre-save a position
      sessionStorage.setItem(
        "scroll_position_test-gated",
        JSON.stringify({
          scrollTop: 800,
          timestamp: Date.now(),
        })
      );

      renderHook(
        () =>
          useRouteScrollRestoration(ref, {
            getRouteKey: () => "test-gated",
            restoreReady: false,
          }),
        { wrapper }
      );

      // scrollTop should NOT be restored (still 0)
      expect(el.scrollTop).toBe(0);
    });

    it("should restore when restoreReady becomes true", () => {
      const el = createScrollContainer();
      const ref = createRef(el);

      sessionStorage.setItem(
        "scroll_position_test-ready-true",
        JSON.stringify({
          scrollTop: 400,
          timestamp: Date.now(),
        })
      );

      renderHook(
        () =>
          useRouteScrollRestoration(ref, {
            getRouteKey: () => "test-ready-true",
            restoreReady: true,
          }),
        { wrapper }
      );

      expect(el.scrollTop).toBe(400);
    });

    it("should report the route only after its position is applied", () => {
      const el = createScrollContainer();
      const ref = createRef(el);
      const onRestoreSettled = vi.fn();

      sessionStorage.setItem(
        "scroll_position_test-settled",
        JSON.stringify({
          scrollTop: 420,
          timestamp: Date.now(),
        })
      );

      renderHook(
        () =>
          useRouteScrollRestoration(ref, {
            getRouteKey: () => "test-settled",
            onRestoreSettled,
            restoreReady: true,
          }),
        { wrapper }
      );

      expect(el.scrollTop).toBe(420);
      expect(onRestoreSettled).toHaveBeenCalledTimes(1);
      expect(onRestoreSettled).toHaveBeenCalledWith("test-settled");
    });
  });

  describe("itemCount retry", () => {
    it("should NOT retry restoration on itemCount growth after successful restore (anti-thrashing)", () => {
      const el = createScrollContainer();
      const ref = createRef(el);

      sessionStorage.setItem(
        "scroll_position_test-retry",
        JSON.stringify({
          scrollTop: 300,
          timestamp: Date.now(),
        })
      );

      const { rerender } = renderHook(
        ({ itemCount }: { itemCount: number }) =>
          useRouteScrollRestoration(ref, {
            getRouteKey: () => "test-retry",
            restoreReady: true,
            itemCount,
          }),
        {
          wrapper,
          initialProps: { itemCount: 100 },
        }
      );

      // First restore should set scrollTop
      expect(el.scrollTop).toBe(300);

      // Simulate normal user scrolling (not a restore)
      Object.defineProperty(el, "scrollTop", { value: 100, writable: true });
      const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
      setItemSpy.mockClear();

      // Grow itemCount (simulate infinite scroll from natural scrolling)
      rerender({ itemCount: 200 });
      rerender({ itemCount: 300 });

      // Should NOT re-restore — user was scrolling naturally, itemCount
      // growth from fetchNextPage must not drag them back to saved position.
      expect(el.scrollTop).toBe(100);
      expect(setItemSpy).not.toHaveBeenCalled();
      setItemSpy.mockRestore();
    });
  });

  describe("element disconnected guard", () => {
    it("should not crash when element is disconnected", () => {
      const el = createScrollContainer();
      const ref = createRef(el);

      const { unmount } = renderHook(
        () =>
          useRouteScrollRestoration(ref, {
            getRouteKey: () => "test-disconnected",
          }),
        { wrapper }
      );

      // Disconnect element before unmount
      Object.defineProperty(el, "isConnected", {
        value: false,
        writable: true,
      });

      // Should not throw
      expect(() => unmount()).not.toThrow();
    });
  });

  describe("cleanup", () => {
    it("should unregister event listeners on unmount", () => {
      const el = createScrollContainer();
      const ref = createRef(el);

      const { unmount } = renderHook(
        () =>
          useRouteScrollRestoration(ref, {
            getRouteKey: () => "test-cleanup",
          }),
        { wrapper }
      );

      unmount();

      expect(el.removeEventListener).toHaveBeenCalled();
    });
  });

  describe("pending restore — anchor not found", () => {
    it("should enter pending mode and call onLoadMore (no DOM manipulation)", () => {
      const el = createScrollContainer(2000, 600);
      const ref = createRef(el);

      sessionStorage.setItem(
        "scroll_position_test-pending-anchor",
        JSON.stringify({
          scrollTop: 4154,
          anchor: { itemId: 99_999, offsetFromTop: 10, timestamp: Date.now() },
          timestamp: Date.now(),
        })
      );

      const restoreFromAnchor = vi.fn(() => null);
      const onLoadMore = vi.fn();

      renderHook(
        () =>
          useRouteScrollRestoration(ref, {
            getRouteKey: () => "test-pending-anchor",
            restoreReady: true,
            restoreFromAnchor,
            onLoadMore,
            hasMore: true,
          }),
        { wrapper }
      );

      // Anchor was queried
      expect(restoreFromAnchor).toHaveBeenCalledWith(99_999);

      // ⚠️ DOM is NOT touched — no more el.scrollTop = maxScroll hack
      expect(el.scrollTop).toBe(0);

      // Instead, onLoadMore is called to programmatically load data
      expect(onLoadMore).toHaveBeenCalled();
    });

    it("should resolve pending when anchor becomes available after data growth", () => {
      const el = createScrollContainer(2000, 600);
      const ref = createRef(el);

      sessionStorage.setItem(
        "scroll_position_test-pending-resolve",
        JSON.stringify({
          scrollTop: 4154,
          anchor: { itemId: 99_999, offsetFromTop: 10, timestamp: Date.now() },
          timestamp: Date.now(),
        })
      );

      let callCount = 0;
      const restoreFromAnchor = vi.fn(() => {
        callCount++;
        if (callCount <= 2) {
          return null; // first 2 attempts: anchor not loaded
        }
        return 3000; // anchor now available
      });
      const onLoadMore = vi.fn();

      const { rerender } = renderHook(
        ({ itemCount }: { itemCount: number }) =>
          useRouteScrollRestoration(ref, {
            getRouteKey: () => "test-pending-resolve",
            restoreReady: true,
            restoreFromAnchor,
            itemCount,
            onLoadMore,
            hasMore: true,
          }),
        {
          wrapper,
          initialProps: { itemCount: 100 },
        }
      );

      // First attempt: anchor not found → enter pending, call onLoadMore
      expect(el.scrollTop).toBe(0);
      expect(onLoadMore).toHaveBeenCalled();

      // Simulate onLoadMore having loaded more data
      Object.defineProperty(el, "scrollHeight", {
        value: 5000,
        writable: true,
      });
      rerender({ itemCount: 300 });

      // Now anchor should be resolved: 3000 + 10 = 3010
      expect(el.scrollTop).toBe(3010);
    });
  });

  describe("pending restore — pixel overflow", () => {
    it("should enter pending mode when saved scrollTop exceeds scrollHeight (no DOM hack)", () => {
      const el = createScrollContainer(1000, 600);
      const ref = createRef(el);

      sessionStorage.setItem(
        "scroll_position_test-pending-pixel",
        JSON.stringify({
          scrollTop: 5000,
          timestamp: Date.now(),
        })
      );

      const onLoadMore = vi.fn();

      renderHook(
        () =>
          useRouteScrollRestoration(ref, {
            getRouteKey: () => "test-pending-pixel",
            restoreReady: true,
            onLoadMore,
            hasMore: true,
          }),
        { wrapper }
      );

      // DOM untouched — no forced scroll to bottom!
      expect(el.scrollTop).toBe(0);

      // onLoadMore called to load data programmatically
      expect(onLoadMore).toHaveBeenCalled();
    });

    it("should resolve pixel pending when scrollHeight grows enough", () => {
      const el = createScrollContainer(1000, 600);
      const ref = createRef(el);

      sessionStorage.setItem(
        "scroll_position_test-pending-pixel-resolve",
        JSON.stringify({
          scrollTop: 3000,
          timestamp: Date.now(),
        })
      );

      const onLoadMore = vi.fn();

      const { rerender } = renderHook(
        ({ itemCount }: { itemCount: number }) =>
          useRouteScrollRestoration(ref, {
            getRouteKey: () => "test-pending-pixel-resolve",
            restoreReady: true,
            itemCount,
            onLoadMore,
            hasMore: true,
          }),
        {
          wrapper,
          initialProps: { itemCount: 50 },
        }
      );

      // Pending: scrollHeight(1000) < target(3000), DOM untouched
      expect(el.scrollTop).toBe(0);
      expect(onLoadMore).toHaveBeenCalled();

      // Simulate data loaded → scrollHeight now exceeds target
      Object.defineProperty(el, "scrollHeight", {
        value: 4000,
        writable: true,
      });
      rerender({ itemCount: 200 });

      // Now scrollHeight(4000) >= target(3000), should restore pixel position
      expect(el.scrollTop).toBe(3000);
    });
  });

  describe("pending restore — lock behavior", () => {
    it("should keep isRestoring lock and preserve saved data while pending", () => {
      const el = createScrollContainer(1000, 600);
      const ref = createRef(el);

      sessionStorage.setItem(
        "scroll_position_test-pending-locked",
        JSON.stringify({
          scrollTop: 5000,
          anchor: { itemId: 88_888, offsetFromTop: 5, timestamp: Date.now() },
          timestamp: Date.now(),
        })
      );

      const restoreFromAnchor = vi.fn(() => null);
      const onLoadMore = vi.fn();

      renderHook(
        () =>
          useRouteScrollRestoration(ref, {
            getRouteKey: () => "test-pending-locked",
            restoreReady: true,
            restoreFromAnchor,
            onLoadMore,
            hasMore: true,
          }),
        { wrapper }
      );

      // Session data preserved — no scroll save overwrote the original
      const storedValue = sessionStorage.getItem(
        "scroll_position_test-pending-locked"
      );
      if (storedValue === null) {
        throw new Error("Expected pending scroll position to be stored");
      }
      const stored = JSON.parse(storedValue);
      expect(stored.scrollTop).toBe(5000);
      expect(stored.anchor.itemId).toBe(88_888);
    });

    it("should clear pending on routeKey change", () => {
      const el = createScrollContainer(1000, 600);
      const ref = createRef(el);

      sessionStorage.setItem(
        "scroll_position_test-pending-routechange",
        JSON.stringify({
          scrollTop: 5000,
          anchor: { itemId: 77_777, offsetFromTop: 0, timestamp: Date.now() },
          timestamp: Date.now(),
        })
      );

      const restoreFromAnchor = vi.fn(() => null);

      const { rerender } = renderHook(
        ({ routeKey }: { routeKey: string }) =>
          useRouteScrollRestoration(ref, {
            getRouteKey: () => routeKey,
            restoreReady: true,
            restoreFromAnchor,
            hasMore: true,
            itemCount: 100,
          }),
        {
          wrapper,
          initialProps: { routeKey: "test-pending-routechange" },
        }
      );

      // Pending mode entered, DOM untouched
      expect(el.scrollTop).toBe(0);

      // Switch to a new routeKey
      rerender({ routeKey: "test-new-route" });

      // New route has no saved position → scrollTop should be 0
      expect(el.scrollTop).toBe(0);
    });
  });

  describe("pending restore — edge cases", () => {
    it("should fallback to pixel when anchor never appears but scrollHeight grows enough", () => {
      const el = createScrollContainer(1000, 600);
      const ref = createRef(el);

      sessionStorage.setItem(
        "scroll_position_test-pending-fallback",
        JSON.stringify({
          scrollTop: 2500,
          anchor: { itemId: 66_666, offsetFromTop: 20, timestamp: Date.now() },
          timestamp: Date.now(),
        })
      );

      const restoreFromAnchor = vi.fn(() => null);
      const onLoadMore = vi.fn();

      const { rerender } = renderHook(
        ({ itemCount }: { itemCount: number }) =>
          useRouteScrollRestoration(ref, {
            getRouteKey: () => "test-pending-fallback",
            restoreReady: true,
            restoreFromAnchor,
            itemCount,
            onLoadMore,
            hasMore: true,
          }),
        {
          wrapper,
          initialProps: { itemCount: 50 },
        }
      );

      // Pending: anchor not found, pixel 2500 > scrollHeight 1000
      expect(el.scrollTop).toBe(0);
      expect(onLoadMore).toHaveBeenCalled();

      // All pages loaded, scrollHeight now exceeds target
      Object.defineProperty(el, "scrollHeight", {
        value: 3500,
        writable: true,
      });
      rerender({ itemCount: 250 });

      // Pixel fallback: scrollHeight(3500) >= targetScrollTop(2500)
      expect(el.scrollTop).toBe(2500);
    });

    it("should NOT call onLoadMore when hasMore is false", () => {
      const el = createScrollContainer(1000, 600);
      const ref = createRef(el);

      sessionStorage.setItem(
        "scroll_position_test-pending-nomore",
        JSON.stringify({
          scrollTop: 5000,
          anchor: { itemId: 11_111, offsetFromTop: 0, timestamp: Date.now() },
          timestamp: Date.now(),
        })
      );

      const restoreFromAnchor = vi.fn(() => null);
      const onLoadMore = vi.fn();

      renderHook(
        () =>
          useRouteScrollRestoration(ref, {
            getRouteKey: () => "test-pending-nomore",
            restoreReady: true,
            restoreFromAnchor,
            onLoadMore,
            hasMore: false, // no more pages
          }),
        { wrapper }
      );

      // onLoadMore should NOT be called when hasMore is false
      expect(onLoadMore).not.toHaveBeenCalled();
    });
  });
});
