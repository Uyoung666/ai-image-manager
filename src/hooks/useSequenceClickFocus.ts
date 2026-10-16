import { useLayoutEffect, useRef } from "react";
import {
  getSequenceClickScrollPlan,
  hasSequenceClickGeometryChanged,
  type SequenceClickFocusGeometry,
} from "@/utils/sequence-click-focus";

function getSequenceFocusSurface(
  inner: HTMLDivElement | null,
  containerWidth: number
) {
  const tray = inner?.closest<HTMLElement>("[data-sequence-tray-id]");
  const outer = inner?.closest<HTMLElement>("[data-masonry-scroll]");
  if (!(inner && tray && outer)) {
    return null;
  }
  const trayRect = tray.getBoundingClientRect();
  if (Math.abs(trayRect.width - containerWidth) > 1) {
    return null;
  }
  return { inner, outer, trayRect };
}

function measureSequenceMember(
  surface: NonNullable<ReturnType<typeof getSequenceFocusSurface>>,
  memberId: number,
  topInset: number,
  alignment: "center" | "nearest"
) {
  const { inner, outer, trayRect } = surface;
  const card = inner.querySelector<HTMLElement>(
    `[data-photo-id="${memberId}"][role="option"]`
  );
  if (!card) {
    return null;
  }
  const cardRect = card.getBoundingClientRect();
  const innerTop = inner.getBoundingClientRect().top + inner.clientTop;
  const outerRect = outer.getBoundingClientRect();
  const outerTop = outerRect.top + outer.clientTop + topInset;
  const bottomInset =
    Number.parseFloat(getComputedStyle(outer).paddingBottom) || 0;
  const outerBottom =
    outerRect.top + outer.clientTop + outer.clientHeight - bottomInset;
  if (
    cardRect.height <= 0 ||
    inner.clientHeight <= 0 ||
    outer.clientHeight <= 0
  ) {
    return null;
  }
  const plan = getSequenceClickScrollPlan({
    cardTop: cardRect.top,
    cardHeight: cardRect.height,
    innerTop,
    innerScrollTop: inner.scrollTop,
    innerScrollHeight: inner.scrollHeight,
    innerClientHeight: inner.clientHeight,
    outerScrollTop: outer.scrollTop,
    outerScrollHeight: outer.scrollHeight,
    outerClientHeight: outer.clientHeight,
    outerCenter: (outerTop + outerBottom) / 2,
    outerViewportHeight: Math.max(0, outerBottom - outerTop),
    alignment,
  });
  return {
    inner,
    outer,
    trayRect,
    cardRect,
    plan,
  };
}

type SequenceFocusMeasurement = NonNullable<
  ReturnType<typeof measureSequenceMember>
>;

export function useSequenceClickFocus({
  scrollRef,
  memberId,
  memberIds,
  columns,
  request,
  containerWidth,
  topInset,
  alignment = "center",
  onGeometry,
  onSettled,
  outerSettled = 0,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  memberId: number | null;
  memberIds: readonly number[];
  columns: number;
  request: number;
  /** Expected border-box width of the full-width sequence tray. */
  containerWidth: number;
  topInset: number;
  alignment?: "center" | "nearest";
  onGeometry?: (geometry: SequenceClickFocusGeometry) => void;
  onSettled?: (request: number) => void;
  /** The outer masonry has committed this request and held it for two frames. */
  outerSettled?: number;
}) {
  const completedRef = useRef(0);
  const geometryRef = useRef<SequenceClickFocusGeometry | null>(null);
  const latestRef = useRef({ onGeometry, onSettled, outerSettled });
  latestRef.current = { onGeometry, onSettled, outerSettled };

  useLayoutEffect(() => {
    if (!request || memberId === null || completedRef.current === request) {
      return;
    }
    const index = memberIds.indexOf(memberId);
    if (index < 0 || columns < 1 || containerWidth <= 0) {
      return;
    }
    let frame = 0;
    let stableFrames = 0;
    const schedule = () => {
      frame = requestAnimationFrame(locate);
    };
    const publishGeometry = ({
      cardRect,
      trayRect,
      inner,
      plan,
    }: SequenceFocusMeasurement) => {
      const geometry = {
        request,
        offsetTop:
          cardRect.top - trayRect.top - (plan.innerScrollTop - inner.scrollTop),
        height: cardRect.height,
        layoutWidth: trayRect.width,
        innerScrollTop: plan.innerScrollTop,
        ...(alignment === "nearest"
          ? { outerScrollTop: plan.outerScrollTop }
          : {}),
      };
      if (hasSequenceClickGeometryChanged(geometryRef.current, geometry)) {
        geometryRef.current = geometry;
        stableFrames = 0;
        latestRef.current.onGeometry?.(geometry);
        return true;
      }
      return false;
    };
    const isReady = ({ inner, outer, plan }: SequenceFocusMeasurement) => {
      return (
        latestRef.current.outerSettled === request &&
        Math.abs(inner.scrollTop - plan.innerScrollTop) <= 1 &&
        Math.abs(outer.scrollTop - plan.outerScrollTop) <= 1
      );
    };
    const locate = () => {
      const surface = getSequenceFocusSurface(
        scrollRef.current,
        containerWidth
      );
      if (!surface) {
        stableFrames = 0;
        schedule();
        return;
      }
      const measurement = measureSequenceMember(
        surface,
        memberId,
        topInset,
        alignment
      );
      if (!measurement) {
        stableFrames = 0;
        schedule();
        return;
      }
      if (publishGeometry(measurement)) {
        schedule();
        return;
      }
      stableFrames = isReady(measurement) ? stableFrames + 1 : 0;
      if (stableFrames >= 2) {
        completedRef.current = request;
        latestRef.current.onSettled?.(request);
        return;
      }
      schedule();
    };
    // The target row is retained by the virtualizer. Publish the joint plan
    // during layout so its parent can commit both scrolls before the paint.
    locate();
    return () => cancelAnimationFrame(frame);
  }, [
    alignment,
    columns,
    containerWidth,
    memberId,
    memberIds,
    request,
    scrollRef,
    topInset,
  ]);
}
