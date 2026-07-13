import { describe, expect, it } from "vitest";
import { calculateScrollRestorePagesNeeded } from "@/hooks/useScrollRestorePreloader";

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
