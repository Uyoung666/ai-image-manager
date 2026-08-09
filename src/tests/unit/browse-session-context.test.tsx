import { act, renderHook } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrowseSessionProvider,
  useBrowseSession,
} from "@/contexts/BrowseSessionContext";

function wrapper({ children }: { children: ReactNode }) {
  return React.createElement(BrowseSessionProvider, null, children);
}

describe("BrowseSessionContext", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  describe("getSession", () => {
    it("should return default session for unknown route", () => {
      const { result } = renderHook(() => useBrowseSession(), { wrapper });
      const session = result.current.getSession("unknown");
      expect(session.selectedIds).toEqual([]);
      expect(session.searchQuery).toBe("");
      expect(session.lastClickedIdx).toBe(-1);
      expect(session.detailDismissed).toBe(false);
      expect(session.dashboardReturn).toBeNull();
      expect(session.sequenceMode).toBe("photos");
    });

    it("should return new object each call for unknown route (not shared reference)", () => {
      const { result } = renderHook(() => useBrowseSession(), { wrapper });
      const s1 = result.current.getSession("unknown");
      const s2 = result.current.getSession("unknown");
      expect(s1).not.toBe(s2); // Different references, safe to mutate
    });
  });

  describe("saveSession", () => {
    it("stores the validated dashboard return context for the current session", () => {
      const { result } = renderHook(() => useBrowseSession(), { wrapper });
      const dashboardReturn = {
        tab: "places" as const,
        range: "custom" as const,
        from: "2026-02-01",
        to: "2026-02-28",
      };

      act(() => {
        result.current.saveSession("home-search", { dashboardReturn });
      });

      expect(result.current.getSession("home-search").dashboardReturn).toEqual(
        dashboardReturn
      );
    });
    it("should save and retrieve partial data", () => {
      const { result } = renderHook(() => useBrowseSession(), { wrapper });

      act(() => {
        result.current.saveSession("home", { selectedIds: [1, 2, 3] });
      });

      const session = result.current.getSession("home");
      expect(session.selectedIds).toEqual([1, 2, 3]);
      // Unspecified fields should have defaults
      expect(session.searchQuery).toBe("");
    });

    it("should merge with existing session", () => {
      const { result } = renderHook(() => useBrowseSession(), { wrapper });

      act(() => {
        result.current.saveSession("home", { selectedIds: [1, 2] });
      });
      act(() => {
        result.current.saveSession("home", { searchQuery: "sunset" });
      });

      const session = result.current.getSession("home");
      expect(session.selectedIds).toEqual([1, 2]);
      expect(session.searchQuery).toBe("sunset");
    });

    it("should persist to sessionStorage", () => {
      const { result } = renderHook(() => useBrowseSession(), { wrapper });

      act(() => {
        result.current.saveSession("home", {
          selectedIds: [42],
          searchQuery: "test",
          lastClickedIdx: 3,
          detailDismissed: true,
        });
      });

      const stored = sessionStorage.getItem("browse_session_home");
      expect(stored).not.toBeNull();
      if (stored === null) {
        throw new Error("Expected browse session to be stored");
      }
      const parsed = JSON.parse(stored);
      expect(parsed.selectedIds).toEqual([42]);
      expect(parsed.searchQuery).toBe("test");
    });

    it("should preserve the sequence gallery mode across remounts", () => {
      const first = renderHook(() => useBrowseSession(), { wrapper });

      act(() => {
        first.result.current.saveSession("home-search", {
          sequenceMode: "sequences",
        });
      });
      first.unmount();

      const second = renderHook(() => useBrowseSession(), { wrapper });
      expect(second.result.current.getSession("home-search").sequenceMode).toBe(
        "sequences"
      );
    });

    it("should delete session from storage when all fields are default", () => {
      const { result } = renderHook(() => useBrowseSession(), { wrapper });

      // Save something
      act(() => {
        result.current.saveSession("home", { selectedIds: [1] });
      });
      expect(sessionStorage.getItem("browse_session_home")).not.toBeNull();

      // Reset to defaults
      act(() => {
        result.current.saveSession("home", {
          selectedIds: [],
          searchQuery: "",
          lastClickedIdx: -1,
          detailDismissed: false,
        });
      });

      // Should be removed
      expect(sessionStorage.getItem("browse_session_home")).toBeNull();
    });

    it("should fallback to sessionStorage after page refresh", () => {
      // Simulate a previous session stored in sessionStorage
      sessionStorage.setItem(
        "browse_session_home",
        JSON.stringify({
          selectedIds: [10, 20],
          searchQuery: "beach",
          lastClickedIdx: 1,
          detailDismissed: false,
        })
      );

      // New hook instance (simulating page reload)
      const { result } = renderHook(() => useBrowseSession(), { wrapper });

      const session = result.current.getSession("home");
      expect(session.selectedIds).toEqual([10, 20]);
      expect(session.searchQuery).toBe("beach");
    });

    it("should handle corrupted JSON in sessionStorage gracefully", () => {
      sessionStorage.setItem("browse_session_home", "not-valid{json");

      const { result } = renderHook(() => useBrowseSession(), { wrapper });

      const session = result.current.getSession("home");
      // Should return defaults, not throw
      expect(session.selectedIds).toEqual([]);
      expect(session.searchQuery).toBe("");
    });
  });

  describe("clearSession", () => {
    it("should remove from both memory and sessionStorage", () => {
      const { result } = renderHook(() => useBrowseSession(), { wrapper });

      act(() => {
        result.current.saveSession("home", { selectedIds: [1, 2] });
      });

      act(() => {
        result.current.clearSession("home");
      });

      const session = result.current.getSession("home");
      expect(session.selectedIds).toEqual([]);
      expect(sessionStorage.getItem("browse_session_home")).toBeNull();
    });
  });

  describe("useBrowseSession outside provider", () => {
    it("should throw when used outside provider", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {
        /* Suppress the expected provider error during this test. */
      });

      expect(() => {
        renderHook(() => useBrowseSession());
      }).toThrow(
        "useBrowseSession must be used within <BrowseSessionProvider>"
      );

      spy.mockRestore();
    });
  });
});
