export interface SequenceClickFocusGeometry {
  height: number;
  innerScrollTop: number;
  layoutWidth: number;
  offsetTop: number;
  outerScrollTop?: number;
  request: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/** Plan both scrolls together, preferring to keep the outer gallery still. */
export function getSequenceClickScrollPlan({
  cardTop,
  cardHeight,
  innerTop,
  innerScrollTop,
  innerScrollHeight,
  innerClientHeight,
  outerScrollTop,
  outerScrollHeight,
  outerClientHeight,
  outerCenter,
  alignment = "center",
  outerViewportHeight = outerClientHeight,
}: {
  cardTop: number;
  cardHeight: number;
  innerTop: number;
  innerScrollTop: number;
  innerScrollHeight: number;
  innerClientHeight: number;
  outerScrollTop: number;
  outerScrollHeight: number;
  outerClientHeight: number;
  outerCenter: number;
  alignment?: "center" | "nearest";
  outerViewportHeight?: number;
}): { innerScrollTop: number; outerScrollTop: number } {
  const innerMax = Math.max(0, innerScrollHeight - innerClientHeight);
  const cardContentTop = cardTop - innerTop + innerScrollTop;
  // These bounds either keep the whole card in the inner viewport or, for a
  // tall card, keep the whole inner viewport covered by the card.
  const oppositeEdge = cardContentTop + cardHeight - innerClientHeight;
  const innerMin = clamp(Math.min(cardContentTop, oppositeEdge), 0, innerMax);
  const innerLimit = clamp(Math.max(cardContentTop, oppositeEdge), 0, innerMax);
  const outerMinDelta = -outerScrollTop;
  const outerMaxDelta =
    Math.max(0, outerScrollHeight - outerClientHeight) - outerScrollTop;
  const centerSum = innerTop + cardContentTop + cardHeight / 2 - outerCenter;
  const visibleSlack = Math.abs(outerViewportHeight - cardHeight) / 2;
  if (alignment === "nearest") {
    const visibleMin = centerSum - visibleSlack;
    const visibleMax = centerSum + visibleSlack;
    const minDelta = Math.max(outerMinDelta, visibleMin - innerLimit);
    const maxDelta = Math.min(outerMaxDelta, visibleMax - innerMin);
    if (minDelta <= maxDelta) {
      const outerDelta = clamp(0, minDelta, maxDelta);
      return {
        innerScrollTop: clamp(
          innerScrollTop,
          Math.max(innerMin, visibleMin - outerDelta),
          Math.min(innerLimit, visibleMax - outerDelta)
        ),
        outerScrollTop: outerScrollTop + outerDelta,
      };
    }
  }
  const desiredSum =
    alignment === "nearest"
      ? clamp(
          innerScrollTop,
          centerSum - visibleSlack,
          centerSum + visibleSlack
        )
      : centerSum;
  const sum = clamp(
    desiredSum,
    outerMinDelta + innerMin,
    outerMaxDelta + innerLimit
  );
  const outerDelta = clamp(
    0,
    Math.max(outerMinDelta, sum - innerLimit),
    Math.min(outerMaxDelta, sum - innerMin)
  );
  return {
    innerScrollTop: sum - outerDelta,
    outerScrollTop: outerScrollTop + outerDelta,
  };
}

export function hasSequenceClickGeometryChanged(
  previous: SequenceClickFocusGeometry | null,
  next: SequenceClickFocusGeometry
): boolean {
  return (
    previous === null ||
    previous.request !== next.request ||
    (previous.outerScrollTop === undefined) !==
      (next.outerScrollTop === undefined) ||
    Math.abs((previous.outerScrollTop ?? 0) - (next.outerScrollTop ?? 0)) >=
      0.5 ||
    Math.abs(previous.innerScrollTop - next.innerScrollTop) >= 0.5 ||
    Math.abs(previous.offsetTop - next.offsetTop) >= 0.5 ||
    Math.abs(previous.height - next.height) >= 0.5 ||
    Math.abs(previous.layoutWidth - next.layoutWidth) >= 0.5
  );
}
