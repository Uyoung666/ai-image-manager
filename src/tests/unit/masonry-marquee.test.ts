import { describe, expect, it } from "vitest";
import type { MasonryItem } from "@/hooks/useMasonryLayout";
import { collectMarqueeSelection } from "@/hooks/useMasonryMarquee";

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
      items
    );
    expect([...selected]).toEqual([]);
  });

  it("selects cards intersecting the marquee rectangle", () => {
    const selected = collectMarqueeSelection(
      { startX: 50, startY: 50, x: 160, y: 160 },
      positions,
      items
    );
    expect([...selected]).toEqual([1, 2, 3, 4]);
  });

  it("supports reverse drag direction", () => {
    const selected = collectMarqueeSelection(
      { startX: 220, startY: 220, x: 120, y: 120 },
      positions,
      items
    );
    expect([...selected]).toEqual([4]);
  });

  it("selects a tall earlier card extending into the marquee", () => {
    const tallPositions: MasonryItem[] = [
      { top: 0, left: 0, width: 100, height: 500 },
      { top: 0, left: 110, width: 100, height: 100 },
      { top: 110, left: 110, width: 100, height: 100 },
      { top: 220, left: 110, width: 100, height: 100 },
      { top: 330, left: 110, width: 100, height: 100 },
    ];
    const selected = collectMarqueeSelection(
      { startX: 10, startY: 400, x: 90, y: 450 },
      tallPositions,
      [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]
    );

    expect([...selected]).toEqual([1]);
  });
});
