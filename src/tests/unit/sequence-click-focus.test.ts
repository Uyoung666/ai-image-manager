import { describe, expect, it } from "vitest";
import {
  getSequenceClickScrollPlan,
  hasSequenceClickGeometryChanged,
} from "@/utils/sequence-click-focus";

const planInput = {
  cardTop: 900,
  cardHeight: 100,
  innerTop: 80,
  innerScrollTop: 100,
  innerScrollHeight: 1600,
  innerClientHeight: 400,
  outerScrollTop: 968,
  outerScrollHeight: 2600,
  outerClientHeight: 600,
  outerCenter: 312,
};

describe("sequence click focus geometry", () => {
  it("reports a new request or geometry changes of at least half a pixel", () => {
    const geometry = {
      request: 1,
      innerScrollTop: 300,
      offsetTop: 80,
      height: 100,
      layoutWidth: 900,
    };
    expect(hasSequenceClickGeometryChanged(null, geometry)).toBe(true);
    expect(
      hasSequenceClickGeometryChanged(geometry, {
        ...geometry,
        offsetTop: 80.4,
      })
    ).toBe(false);
    expect(
      hasSequenceClickGeometryChanged(geometry, {
        ...geometry,
        offsetTop: 80.5,
      })
    ).toBe(true);
    expect(
      hasSequenceClickGeometryChanged(geometry, { ...geometry, request: 2 })
    ).toBe(true);
    expect(
      hasSequenceClickGeometryChanged(geometry, {
        ...geometry,
        innerScrollTop: 300.5,
      })
    ).toBe(true);
    expect(
      hasSequenceClickGeometryChanged(geometry, {
        ...geometry,
        outerScrollTop: 0,
      })
    ).toBe(true);
  });
});

describe("nearest sequence keyboard scroll plan", () => {
  const input = {
    ...planInput,
    alignment: "nearest" as const,
    innerTop: 100,
    innerScrollTop: 200,
    outerScrollTop: 500,
    outerCenter: 300,
    outerViewportHeight: 400,
  };
  it("leaves an already visible member in place instead of centering it", () => {
    expect(getSequenceClickScrollPlan({ ...input, cardTop: 250 })).toEqual({
      innerScrollTop: 200,
      outerScrollTop: 500,
    });
  });
  it.each([
    { cardTop: 450, expectedInner: 250 },
    { cardTop: 60, expectedInner: 160 },
  ])("reveals only the clipped edge at $cardTop using the inner scroll", ({
    cardTop,
    expectedInner,
  }) => {
    expect(getSequenceClickScrollPlan({ ...input, cardTop })).toEqual({
      innerScrollTop: expectedInner,
      outerScrollTop: 500,
    });
  });
  it("moves the outer only when the inner cannot reveal the member by itself", () => {
    expect(
      getSequenceClickScrollPlan({ ...input, innerTop: 480, cardTop: 580 })
    ).toEqual({ innerScrollTop: 300, outerScrollTop: 580 });
    expect(
      getSequenceClickScrollPlan({ ...input, innerTop: -280, cardTop: -80 })
    ).toEqual({ innerScrollTop: 100, outerScrollTop: 420 });
  });
  it("does not move a tall member that already covers the usable viewport", () => {
    expect(
      getSequenceClickScrollPlan({ ...input, cardTop: 50, cardHeight: 700 })
    ).toEqual({ innerScrollTop: 200, outerScrollTop: 500 });
  });
  it("clamps to the closest reachable position at the outer boundary", () => {
    expect(
      getSequenceClickScrollPlan({
        ...input,
        innerTop: 600,
        cardTop: 700,
        outerScrollTop: 0,
        outerScrollHeight: 600,
      })
    ).toEqual({ innerScrollTop: 300, outerScrollTop: 0 });
  });
});

describe("joint sequence click scroll plan", () => {
  it("centers using only the inner scroll when the outer can stay still", () => {
    expect(getSequenceClickScrollPlan(planInput)).toEqual({
      innerScrollTop: 738,
      outerScrollTop: 968,
    });
  });

  it("moves the outer only as far as required to keep the member in the inner clip", () => {
    expect(
      getSequenceClickScrollPlan({
        ...planInput,
        cardTop: 1480,
        innerTop: 580,
        innerScrollTop: 0,
      })
    ).toEqual({ innerScrollTop: 900, outerScrollTop: 1286 });
    expect(
      getSequenceClickScrollPlan({
        ...planInput,
        cardTop: 620,
        innerTop: -280,
        innerScrollTop: 0,
      })
    ).toEqual({ innerScrollTop: 600, outerScrollTop: 726 });
  });

  it("compensates at the outer start without first centering the inner viewport", () => {
    expect(
      getSequenceClickScrollPlan({
        ...planInput,
        cardTop: 980,
        innerTop: 80,
        innerScrollTop: 0,
        outerScrollTop: 0,
      })
    ).toEqual({ innerScrollTop: 718, outerScrollTop: 0 });
  });

  it("keeps the card at the nearest visible position when the outer end prevents centering", () => {
    expect(
      getSequenceClickScrollPlan({
        ...planInput,
        cardTop: 1280,
        innerTop: 380,
        innerScrollTop: 0,
        outerScrollTop: 1000,
        outerScrollHeight: 1600,
      })
    ).toEqual({ innerScrollTop: 900, outerScrollTop: 1000 });
  });

  it("handles the first and last members with inner scroll boundaries", () => {
    expect(getSequenceClickScrollPlan({ ...planInput, cardTop: -20 })).toEqual({
      innerScrollTop: 0,
      outerScrollTop: 786,
    });
    expect(getSequenceClickScrollPlan({ ...planInput, cardTop: 1480 })).toEqual(
      { innerScrollTop: 1200, outerScrollTop: 1086 }
    );
  });

  it("centers a tall card while retaining the full inner viewport", () => {
    expect(
      getSequenceClickScrollPlan({
        ...planInput,
        cardTop: 100,
        cardHeight: 900,
      })
    ).toEqual({ innerScrollTop: 338, outerScrollTop: 968 });
  });
});
