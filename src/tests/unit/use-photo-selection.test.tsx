import { act, renderHook } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { BrowseSessionProvider } from "@/contexts/BrowseSessionContext";
import { usePhotoSelection } from "@/hooks/usePhotoSelection";

const mockPhotos = [
  { id: 1, width: 800, height: 600 },
  { id: 2, width: 600, height: 800 },
  { id: 3, width: 1200, height: 900 },
  { id: 4, width: 400, height: 300 },
  { id: 5, width: 1000, height: 750 },
];

function wrapper({ children }: { children: ReactNode }) {
  return React.createElement(BrowseSessionProvider, null, children);
}

function createMouseEvent(
  overrides: Partial<React.MouseEvent> = {}
): React.MouseEvent {
  return {
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    button: 0,
    ...overrides,
  } as React.MouseEvent;
}

describe("usePhotoSelection", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  describe("initial state", () => {
    it("should start with empty selection", () => {
      const { result } = renderHook(
        () => usePhotoSelection("test-route", mockPhotos),
        { wrapper }
      );
      expect(result.current.selectedIds.size).toBe(0);
      expect(result.current.lastClickedIdx).toBe(-1);
    });

    it("should restore selection from BrowseSession", () => {
      // Pre-populate sessionStorage
      sessionStorage.setItem(
        "browse_session_test-restore",
        JSON.stringify({
          selectedIds: [1, 3],
          searchQuery: "",
          searchMode: null,
          colorHex: null,
          lastClickedIdx: 2,
          detailDismissed: false,
        })
      );

      const { result } = renderHook(
        () => usePhotoSelection("test-restore", mockPhotos),
        { wrapper }
      );

      expect(result.current.selectedIds).toEqual(new Set([1, 3]));
      expect(result.current.lastClickedIdx).toBe(2);
    });

    it("should filter out invalid IDs on restore", () => {
      sessionStorage.setItem(
        "browse_session_test-invalid",
        JSON.stringify({
          selectedIds: [1, 99, 3], // 99 doesn't exist
          searchQuery: "",
          searchMode: null,
          colorHex: null,
          lastClickedIdx: 0,
          detailDismissed: false,
        })
      );

      const { result } = renderHook(
        () => usePhotoSelection("test-invalid", mockPhotos),
        { wrapper }
      );

      expect(result.current.selectedIds).toEqual(new Set([1, 3]));
    });
  });

  describe("routeKey changes", () => {
    it("should reload selection when routeKey changes", () => {
      const { result, rerender } = renderHook(
        ({ routeKey }) => usePhotoSelection(routeKey, mockPhotos),
        { wrapper, initialProps: { routeKey: "route-a" } }
      );

      // Select photo 1 in route-a
      act(() => {
        result.current.handleKeyboardSelect(1);
      });
      expect(result.current.selectedIds).toEqual(new Set([1]));

      // Switch to route-b (should load empty selection)
      rerender({ routeKey: "route-b" });
      expect(result.current.selectedIds.size).toBe(0);

      // Switch back to route-a (should restore selection)
      rerender({ routeKey: "route-a" });
      expect(result.current.selectedIds).toEqual(new Set([1]));
    });

    it("restores session selection after photos arrive asynchronously", () => {
      sessionStorage.setItem(
        "browse_session_async-photos",
        JSON.stringify({
          selectedIds: [2],
          searchQuery: "",
          searchMode: null,
          colorHex: null,
          lastClickedIdx: 0,
          detailDismissed: false,
        })
      );
      const { result, rerender } = renderHook(
        ({ photos }) => usePhotoSelection("async-photos", photos),
        { wrapper, initialProps: { photos: [] as typeof mockPhotos } }
      );

      expect(result.current.selectedIds).toEqual(new Set());
      rerender({ photos: mockPhotos });

      expect(result.current.selectedIds).toEqual(new Set([2]));
    });
  });

  describe("handleSelect", () => {
    it("should select a single photo on plain click", () => {
      const { result } = renderHook(
        () => usePhotoSelection("test", mockPhotos),
        { wrapper }
      );

      act(() => {
        result.current.handleSelect(1, createMouseEvent());
      });

      expect(result.current.selectedIds).toEqual(new Set([1]));
    });

    it("should clear previous selection on plain click", () => {
      const { result } = renderHook(
        () => usePhotoSelection("test", mockPhotos),
        { wrapper }
      );

      act(() => {
        result.current.handleSelect(1, createMouseEvent());
      });
      act(() => {
        result.current.handleSelect(3, createMouseEvent());
      });

      expect(result.current.selectedIds).toEqual(new Set([3]));
    });

    it("should toggle selection with Ctrl+click", () => {
      const { result } = renderHook(
        () => usePhotoSelection("test", mockPhotos),
        { wrapper }
      );

      act(() => {
        result.current.handleSelect(1, createMouseEvent());
      });
      act(() => {
        result.current.handleSelect(2, createMouseEvent({ ctrlKey: true }));
      });

      expect(result.current.selectedIds).toEqual(new Set([1, 2]));

      // Ctrl+click again to deselect
      act(() => {
        result.current.handleSelect(2, createMouseEvent({ ctrlKey: true }));
      });
      expect(result.current.selectedIds).toEqual(new Set([1]));
    });

    it("should range-select with Shift+click", () => {
      const { result } = renderHook(
        () => usePhotoSelection("test", mockPhotos),
        { wrapper }
      );

      // First click sets the anchor
      act(() => {
        result.current.handleSelect(1, createMouseEvent());
      });

      // Shift+click on photo 4 selects range [1..4]
      act(() => {
        result.current.handleSelect(4, createMouseEvent({ shiftKey: true }));
      });

      expect(result.current.selectedIds).toEqual(new Set([1, 2, 3, 4]));
    });
  });

  describe("handleKeyboardSelect", () => {
    it("should select a single photo", () => {
      const { result } = renderHook(
        () => usePhotoSelection("test", mockPhotos),
        { wrapper }
      );

      act(() => {
        result.current.handleKeyboardSelect(2);
      });

      expect(result.current.selectedIds).toEqual(new Set([2]));
      expect(result.current.lastClickedIdx).toBe(1);
    });
  });

  describe("handleMarqueeSelect", () => {
    it("should replace selection with marquee set", () => {
      const { result } = renderHook(
        () => usePhotoSelection("test", mockPhotos),
        { wrapper }
      );

      act(() => {
        result.current.handleSelect(1, createMouseEvent());
      });
      act(() => {
        result.current.handleMarqueeSelect(new Set([3, 4, 5]));
      });

      expect(result.current.selectedIds).toEqual(new Set([3, 4, 5]));
    });
  });

  describe("clearSelection", () => {
    it("should clear all selected IDs", () => {
      const { result } = renderHook(
        () => usePhotoSelection("test", mockPhotos),
        { wrapper }
      );

      act(() => {
        result.current.handleMarqueeSelect(new Set([1, 2, 3]));
      });
      act(() => {
        result.current.clearSelection();
      });

      expect(result.current.selectedIds.size).toBe(0);
      expect(result.current.lastClickedIdx).toBe(-1);
    });
  });

  describe("removeFromSelection", () => {
    it("should remove specific IDs", () => {
      const { result } = renderHook(
        () => usePhotoSelection("test", mockPhotos),
        { wrapper }
      );

      act(() => {
        result.current.handleMarqueeSelect(new Set([1, 2, 3]));
      });
      act(() => {
        result.current.removeFromSelection([2]);
      });

      expect(result.current.selectedIds).toEqual(new Set([1, 3]));
    });
  });

  describe("selectAll", () => {
    it("should select all photos", () => {
      const { result } = renderHook(
        () => usePhotoSelection("test", mockPhotos),
        { wrapper }
      );

      act(() => {
        result.current.selectAll();
      });

      expect(result.current.selectedIds.size).toBe(mockPhotos.length);
    });

    it("should deselect all when all are already selected", () => {
      const { result } = renderHook(
        () => usePhotoSelection("test", mockPhotos),
        { wrapper }
      );

      act(() => {
        result.current.selectAll(); // Select all
      });
      act(() => {
        result.current.selectAll(); // Deselect all
      });

      expect(result.current.selectedIds.size).toBe(0);
    });
  });
});
