import { describe, expect, it } from "vitest";
import { collectMarqueeSelection } from "@/hooks/useMasonryMarquee";
import type { MasonryItem } from "@/hooks/useMasonryLayout";

const positions: MasonryItem[] = [
  { top: 0, left: 0, width: 100, height: 100 },
  { top: 0, left: 110, width: 100, height: 100 },
  { top: 110, left: 0, width: 100, height: 100 },
  { top: 110, left: 110, width: 100, height: 100 },
];
const items = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];

describe("collectMarqueeSelection", () => {
  it("ignores drags below the threshold", () => {
    const selected = collectMarqueeSelection(
      { startX: 0, startY: 0, x: 4, y: 20 },
      positions,
      items,
      2
    );
    expect([...selected]).toEqual([]);
  });

  it("selects cards intersecting the marquee rectangle", () => {
    const selected = collectMarqueeSelection(
      { startX: 50, startY: 50, x: 160, y: 160 },
      positions,
      items,
      2
    );
    expect([...selected]).toEqual([1, 2, 3, 4]);
  });

  it("supports reverse drag direction", () => {
    const selected = collectMarqueeSelection(
      { startX: 220, startY: 220, x: 120, y: 120 },
      positions,
      items,
      2
    );
    expect([...selected]).toEqual([4]);
  });
});
