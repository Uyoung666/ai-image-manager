import { describe, expect, it } from "vitest";
import {
  canPaginateGalleryPhotos,
  createSearchResultSourceKey,
  getDisplayedSequenceMode,
  getStableSearchAppendIds,
  isGalleryRevealPending,
  isSequenceSourceReady,
  shouldUseImmediateGalleryPhotos,
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

  it("does not render deferred search photos after clearing search", () => {
    const searchPhotos = [{ id: 1 }];
    const galleryPhotos = [{ id: 2 }];

    expect(
      shouldUseImmediateGalleryPhotos({
        deferredPhotos: searchPhotos,
        isSearching: false,
        lastSearchPhotos: searchPhotos,
        rawPhotos: galleryPhotos,
      })
    ).toBe(true);
    expect(
      shouldUseImmediateGalleryPhotos({
        deferredPhotos: searchPhotos,
        isSearching: false,
        lastSearchPhotos: null,
        rawPhotos: galleryPhotos,
      })
    ).toBe(false);
    expect(
      shouldUseImmediateGalleryPhotos({
        deferredPhotos: galleryPhotos,
        isSearching: true,
        lastSearchPhotos: searchPhotos,
        rawPhotos: galleryPhotos,
      })
    ).toBe(true);
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

  it("changes the committed search source only when generation or result ids change", () => {
    expect(createSearchResultSourceKey(4, [11, 12])).toBe("4:11,12");
    expect(createSearchResultSourceKey(4, [11, 12])).toBe(
      createSearchResultSourceKey(4, [11, 12])
    );
    expect(createSearchResultSourceKey(5, [11, 12])).not.toBe("4:11,12");
    expect(createSearchResultSourceKey(4, [11, 13])).not.toBe("4:11,12");
  });

  it("keeps the old sequence layout while a new search result is pending", () => {
    expect(
      isSequenceSourceReady({
        currentGeneration: 4,
        currentIds: [11, 12],
        currentSourceKey: "search:4:11,12:sequence:0:11,12",
        isSearching: true,
        previousGeneration: 4,
        previousIds: [11, 12],
        previousSourceKey: "search:4:11,12:sequence:0:11,12",
        refreshUnchanged: true,
      })
    ).toBe(true);
    expect(
      isSequenceSourceReady({
        currentGeneration: 5,
        currentIds: [21, 22],
        currentSourceKey: "search:5:21,22:sequence:0:21,22",
        isSearching: true,
        previousGeneration: 4,
        previousIds: [11, 12],
        previousSourceKey: "search:4:11,12:sequence:0:11,12",
        refreshUnchanged: true,
      })
    ).toBe(false);
  });

  it("keeps a stable sequence prefix ready during search pagination", () => {
    expect(
      isSequenceSourceReady({
        currentGeneration: 4,
        currentIds: [11, 12, 13],
        currentSourceKey: "search:4:11,12:sequence:0:11,12,13",
        isSearching: true,
        previousGeneration: 4,
        previousIds: [11, 12],
        previousSourceKey: "search:4:11,12:sequence:0:11,12",
        refreshUnchanged: true,
      })
    ).toBe(true);
  });
});
