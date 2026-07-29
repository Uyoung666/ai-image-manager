import { describe, expect, it } from "vitest";
import {
  calculateScrollRestorePagesNeeded,
  resolveScrollRestorePreloadState,
} from "@/hooks/useScrollRestorePreloader";

describe("calculateScrollRestorePagesNeeded", () => {
  it("does not force page 3 preload for first-page anchors", () => {
    expect(calculateScrollRestorePagesNeeded(0, 100)).toBe(1);
    expect(calculateScrollRestorePagesNeeded(99, 100)).toBe(1);
  });

  it("keeps one page of margin for deeper restore anchors", () => {
    expect(calculateScrollRestorePagesNeeded(100, 100)).toBe(3);
    expect(calculateScrollRestorePagesNeeded(250, 100)).toBe(4);
  });
});

describe("resolveScrollRestorePreloadState", () => {
  it("does not gate a gallery without a saved position", () => {
    expect(
      resolveScrollRestorePreloadState({
        currentItemCount: 0,
        hasMore: false,
        isInitialLoading: false,
        pageSize: 100,
        savedScrollTop: 0,
      })
    ).toBe("not-needed");
  });

  it("keeps a saved return position hidden while the first page loads", () => {
    expect(
      resolveScrollRestorePreloadState({
        currentItemCount: 0,
        estimatedGlobalIndex: 420,
        hasMore: false,
        isInitialLoading: true,
        pageSize: 100,
        savedScrollTop: 5000,
      })
    ).toBe("checking");
  });

  it("preloads deep anchors and positions immediately when data is ready", () => {
    const base = {
      estimatedGlobalIndex: 420,
      hasMore: true,
      isInitialLoading: false,
      pageSize: 100,
      savedScrollTop: 5000,
    };

    expect(
      resolveScrollRestorePreloadState({
        ...base,
        currentItemCount: 100,
      })
    ).toBe("preloading");
    expect(
      resolveScrollRestorePreloadState({
        ...base,
        currentItemCount: 600,
      })
    ).toBe("positioning");
  });
});
