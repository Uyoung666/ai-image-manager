import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  type GroupHeaderInput,
  type MasonryLayoutInput,
  useMasonryLayout,
} from "@/hooks/useMasonryLayout";

interface HookProps {
  headers?: GroupHeaderInput[];
  items: MasonryLayoutInput[];
  layoutKey: string;
}

function renderLayout(initialProps: HookProps) {
  return renderHook(
    ({ headers, items, layoutKey }: HookProps) =>
      useMasonryLayout(items, 208, 2, 8, headers, layoutKey),
    { initialProps }
  );
}

const baseItems: MasonryLayoutInput[] = [
  { height: 100, id: 1, width: 100 },
  { height: 100, id: 2, width: 200 },
];

describe("useMasonryLayout cache safety", () => {
  it("recomputes when a larger list has the same first id but a different prefix", () => {
    const { result, rerender } = renderLayout({
      items: baseItems,
      layoutKey: "folder-1",
    });
    expect(result.current.positions[1].height).toBe(50);

    rerender({
      items: [
        baseItems[0],
        { height: 200, id: 3, width: 100 },
        { height: 100, id: 4, width: 100 },
      ],
      layoutKey: "folder-1",
    });

    expect(result.current.positions[1].height).toBeCloseTo(100 / 0.6);
    expect(result.current.positions).toHaveLength(3);
    expect(result.current.visibilityIndex).toHaveLength(3);
  });

  it("recomputes when an existing item's dimensions change during append", () => {
    const { result, rerender } = renderLayout({
      items: baseItems,
      layoutKey: "all",
    });
    expect(result.current.positions[0].height).toBe(100);

    rerender({
      items: [
        { height: 200, id: 1, width: 100 },
        baseItems[1],
        { height: 100, id: 3, width: 100 },
      ],
      layoutKey: "all",
    });

    expect(result.current.positions[0].height).toBeCloseTo(100 / 0.6);
  });

  it("does not reuse cached positions after the layout key changes", () => {
    const { result, rerender } = renderLayout({
      items: baseItems,
      layoutKey: "folder-1",
    });
    result.current.positions[0].top = 999;

    rerender({
      items: [...baseItems, { height: 100, id: 3, width: 100 }],
      layoutKey: "all",
    });

    expect(result.current.positions[0].top).toBe(0);
  });

  it("preserves cached positions for a genuine tail append", () => {
    const { result, rerender } = renderLayout({
      items: baseItems,
      layoutKey: "all",
    });
    const firstPosition = result.current.positions[0];

    rerender({
      items: [...baseItems, { height: 100, id: 3, width: 100 }],
      layoutKey: "all",
    });

    expect(result.current.positions[0]).toBe(firstPosition);
    expect(result.current.positions[2].top).toBe(58);
    expect(result.current.positions).toHaveLength(3);
    expect(result.current.visibilityIndex).toHaveLength(3);
  });

  it("inserts an appended group header using its global item index", () => {
    const { result, rerender } = renderLayout({
      headers: [{ beforeIndex: 0, label: "January" }],
      items: baseItems,
      layoutKey: "all",
    });

    rerender({
      headers: [
        { beforeIndex: 0, label: "January" },
        { beforeIndex: 2, label: "February" },
      ],
      items: [...baseItems, { height: 100, id: 3, width: 100 }],
      layoutKey: "all",
    });

    expect(result.current.headerPositions).toEqual([
      { label: "January", top: 0 },
      { label: "February", top: 152 },
    ]);
    expect(result.current.positions[2].top).toBe(196);
    expect(result.current.positions).toHaveLength(3);
    expect(result.current.visibilityIndex).toHaveLength(3);
  });
});
