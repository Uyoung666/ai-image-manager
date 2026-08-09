import { act, renderHook } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ScrollPositionProvider,
  useScrollPosition,
} from "@/contexts/ScrollPositionContext";

function wrapper({ children }: { children: ReactNode }) {
  return React.createElement(ScrollPositionProvider, null, children);
}

// Helper to advance time
function advanceTime(ms: number) {
  vi.advanceTimersByTime(ms);
}

describe("ScrollPositionContext", () => {
  beforeEach(() => {
    sessionStorage.clear();
    (window as Window & { __scrollLog?: unknown[] }).__scrollLog = undefined;
    vi.useFakeTimers();
    // Set a fixed "now" time so expiry checks are deterministic
    vi.setSystemTime(new Date("2026-06-10T12:00:00Z"));
  });

  describe("saveScrollPosition", () => {
    it("should save position to the in-memory map", () => {
      const { result } = renderHook(() => useScrollPosition(), { wrapper });

      act(() => {
        result.current.saveScrollPosition("home", 500, {
          itemId: 42,
          offsetFromTop: 10,
          offsetRatio: 0.1,
          timestamp: Date.now(),
        });
      });

      const saved = result.current.getScrollPosition("home");
      expect(saved).not.toBeNull();
      expect(saved?.scrollTop).toBe(500);
      expect(saved?.anchor).toEqual({
        itemId: 42,
        offsetFromTop: 10,
        offsetRatio: 0.1,
        timestamp: expect.any(Number),
      });
    });

    it("should persist to sessionStorage", () => {
      const { result } = renderHook(() => useScrollPosition(), { wrapper });

      act(() => {
        result.current.saveScrollPosition("home", 1234);
        advanceTime(300);
      });

      const stored = sessionStorage.getItem("scroll_position_home");
      expect(stored).not.toBeNull();
      if (stored === null) {
        throw new Error("Expected scroll position to be stored");
      }
      const parsed = JSON.parse(stored);
      expect(parsed.scrollTop).toBe(1234);
    });

    it("should not throw when sessionStorage is unavailable", () => {
      const originalSetItem = sessionStorage.setItem;
      sessionStorage.setItem = () => {
        throw new Error("QuotaExceededError");
      };

      const { result } = renderHook(() => useScrollPosition(), { wrapper });

      expect(() => {
        act(() => {
          result.current.saveScrollPosition("home", 500);
          advanceTime(300);
        });
      }).not.toThrow();

      // In-memory should still work
      const saved = result.current.getScrollPosition("home");
      expect(saved).not.toBeNull();

      sessionStorage.setItem = originalSetItem;
    });

    it("should keep scroll diagnostics disabled by default", () => {
      const warnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const { result } = renderHook(() => useScrollPosition(), { wrapper });

      act(() => {
        for (let i = 0; i < 600; i++) {
          result.current.saveScrollPosition("home", i);
        }
      });

      expect(
        (window as Window & { __scrollLog?: unknown[] }).__scrollLog
      ).toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe("getScrollPosition", () => {
    it("should return null for non-existent position", () => {
      const { result } = renderHook(() => useScrollPosition(), { wrapper });
      expect(result.current.getScrollPosition("unknown")).toBeNull();
    });

    it("should return saved position from memory", () => {
      const { result } = renderHook(() => useScrollPosition(), { wrapper });

      act(() => {
        result.current.saveScrollPosition("home", 500);
      });

      const saved = result.current.getScrollPosition("home");
      expect(saved).not.toBeNull();
      expect(saved?.scrollTop).toBe(500);
    });

    it("should fallback to sessionStorage when memory is empty", () => {
      // Save directly to sessionStorage (simulating page refresh)
      const data = {
        scrollTop: 999,
        anchor: undefined,
        timestamp: Date.now(),
      };
      sessionStorage.setItem("scroll_position_home", JSON.stringify(data));

      // New hook instance (simulating page reload)
      const { result } = renderHook(() => useScrollPosition(), { wrapper });

      const saved = result.current.getScrollPosition("home");
      expect(saved).not.toBeNull();
      expect(saved?.scrollTop).toBe(999);
    });

    it("should return null for expired positions", () => {
      const { result } = renderHook(() => useScrollPosition(), { wrapper });

      act(() => {
        result.current.saveScrollPosition("home", 500);
      });

      // Advance past the 30-minute expiry
      advanceTime(31 * 60 * 1000);

      const saved = result.current.getScrollPosition("home");
      expect(saved).toBeNull();

      // sessionStorage should also be cleaned
      expect(sessionStorage.getItem("scroll_position_home")).toBeNull();
    });

    it("should handle corrupted JSON in sessionStorage gracefully", () => {
      sessionStorage.setItem("scroll_position_home", "not-valid-json{{{");

      const { result } = renderHook(() => useScrollPosition(), { wrapper });

      expect(() => {
        const saved = result.current.getScrollPosition("home");
        expect(saved).toBeNull();
      }).not.toThrow();
    });
  });

  describe("clearScrollPosition", () => {
    it("should remove from both memory and sessionStorage", () => {
      const { result } = renderHook(() => useScrollPosition(), { wrapper });

      act(() => {
        result.current.saveScrollPosition("home", 500);
        advanceTime(300);
      });
      expect(sessionStorage.getItem("scroll_position_home")).not.toBeNull();

      act(() => {
        result.current.clearScrollPosition("home");
      });

      expect(result.current.getScrollPosition("home")).toBeNull();
      expect(sessionStorage.getItem("scroll_position_home")).toBeNull();
    });
  });

  describe("clearAllScrollPositions", () => {
    it("should clear all scroll position keys from sessionStorage", () => {
      const { result } = renderHook(() => useScrollPosition(), { wrapper });

      act(() => {
        result.current.saveScrollPosition("home", 100);
        result.current.saveScrollPosition("album-1", 200);
        result.current.saveScrollPosition("trash", 300);
      });

      // Also add a non-scroll-position key
      sessionStorage.setItem("other_key", "value");

      act(() => {
        result.current.clearAllScrollPositions();
        advanceTime(300);
      });

      expect(sessionStorage.getItem("scroll_position_home")).toBeNull();
      expect(sessionStorage.getItem("scroll_position_album-1")).toBeNull();
      expect(sessionStorage.getItem("scroll_position_trash")).toBeNull();
      // Unrelated keys should not be touched
      expect(sessionStorage.getItem("other_key")).toBe("value");
    });
  });

  describe("markRouteDirty", () => {
    it("should not let a pending save restore a stale anchor", () => {
      const { result } = renderHook(() => useScrollPosition(), { wrapper });

      act(() => {
        result.current.saveScrollPosition("home", 500, {
          itemId: 42,
          offsetFromTop: 10,
          offsetRatio: 0.1,
          timestamp: Date.now(),
        });
        result.current.markRouteDirty("home");
        advanceTime(300);
      });

      const stored = sessionStorage.getItem("scroll_position_home");
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored ?? "{}").anchor).toBeUndefined();
      expect(result.current.getScrollPosition("home")?.anchor).toBeUndefined();
    });
  });

  describe("LRU cache eviction", () => {
    it("should evict oldest entry from memory when exceeding MAX_CACHED_ROUTES (30)", () => {
      const { result } = renderHook(() => useScrollPosition(), { wrapper });
      const now = Date.now();

      // Save 31 routes with increasing timestamps
      for (let i = 0; i < 31; i++) {
        vi.setSystemTime(now + i * 1000);
        act(() => {
          result.current.saveScrollPosition(`route-${i}`, i * 100);
        });
      }

      // route-0 has timestamp now+0, route-30 has now+30000.
      // After saving route-30 (31st entry), LRU evicts route-0 (oldest)
      // from BOTH memory AND sessionStorage.
      vi.setSystemTime(now + 31 * 1000);
      act(() => {
        advanceTime(300);
      });
      expect(result.current.getScrollPosition("route-0")).toBeNull();
      expect(sessionStorage.getItem("scroll_position_route-0")).toBeNull();
      // route-30 should definitely exist
      expect(result.current.getScrollPosition("route-30")).not.toBeNull();
    });
  });

  describe("useScrollPosition outside provider", () => {
    it("should throw when used outside ScrollPositionProvider", () => {
      // Suppress console.error for the expected error boundary test
      const spy = vi.spyOn(console, "error").mockImplementation(() => {
        /* Suppress the expected provider error during this test. */
      });

      expect(() => {
        renderHook(() => useScrollPosition());
      }).toThrow(
        "useScrollPosition must be used within <ScrollPositionProvider>"
      );

      spy.mockRestore();
    });
  });
});
