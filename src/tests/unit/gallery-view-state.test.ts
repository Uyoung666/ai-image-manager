import { describe, expect, it } from "vitest";
import {
  canPaginateGalleryPhotos,
  getDisplayedSequenceMode,
  getStableSearchAppendIds,
  isGalleryRevealPending,
} from "@/utils/gallery-view-state";

describe("gallery view state", () => {
  it("shows already loaded sequences immediately after switching modes", () => {
    expect(getDisplayedSequenceMode("sequences", true)).toBe("sequences");
    expect(getDisplayedSequenceMode("sequences", false)).toBe("photos");
  });

  it("keeps photo pagination enabled while a detail panel is handled separately", () => {
    expect(canPaginateGalleryPhotos("photos", true)).toBe(true);
    expect(canPaginateGalleryPhotos("photos", false)).toBe(false);
    expect(canPaginateGalleryPhotos("sequences", true)).toBe(false);
  });

  it("keeps the gallery hidden until delayed sequence structure is ready", () => {
    expect(
      isGalleryRevealPending({
        hasSavedPosition: true,
        restoredRouteKey: "home-all",
        routeKey: "home-all",
        sequenceViewReady: false,
      })
    ).toBe(true);

    expect(
      isGalleryRevealPending({
        hasSavedPosition: true,
        restoredRouteKey: "home-all",
        routeKey: "home-all",
        sequenceViewReady: true,
      })
    ).toBe(false);
  });

  it("waits for sequence structure even without a saved scroll position", () => {
    expect(
      isGalleryRevealPending({
        hasSavedPosition: false,
        restoredRouteKey: null,
        routeKey: "home-all",
        sequenceViewReady: false,
      })
    ).toBe(true);
  });

  it("treats cursor pagination as an append only when the rendered prefix is stable", () => {
    expect(
      getStableSearchAppendIds({
        currentIds: [1, 2, 3, 4],
        currentSearchKey: "text:自行车",
        isSearching: true,
        previousIds: [1, 2],
        previousSearchKey: "text:自行车",
        refreshUnchanged: true,
      })
    ).toEqual([3, 4]);
    expect(
      getStableSearchAppendIds({
        currentIds: [2, 1, 3],
        currentSearchKey: "text:自行车",
        isSearching: true,
        previousIds: [1, 2],
        previousSearchKey: "text:自行车",
        refreshUnchanged: true,
      })
    ).toBeNull();
  });
});
