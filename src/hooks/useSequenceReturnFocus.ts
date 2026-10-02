import { useLayoutEffect, useRef } from "react";
import { getReturnScrollTop } from "@/utils/gallery-return";

function applyReturnScroll(element: HTMLElement, next: number | null) {
  if (next === null || Math.abs(next - element.scrollTop) <= 1) {
    return false;
  }
  element.scrollTop = next;
  return true;
}

export function useSequenceReturnFocus({
  scrollRef,
  memberId,
  memberIds,
  columns,
  request,
  scrollToRow,
  onLocated,
  topInset,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  memberId: number | null;
  memberIds: readonly number[];
  columns: number;
  request: number;
  scrollToRow: (index: number) => void;
  onLocated?: (request: number) => void;
  topInset: number;
}) {
  const completedRef = useRef(0);
  const onLocatedRef = useRef(onLocated);
  onLocatedRef.current = onLocated;
  useLayoutEffect(() => {
    if (!request || request === completedRef.current || memberId === null) {
      return;
    }
    const index = memberIds.indexOf(memberId);
    if (index < 0 || !scrollRef.current) {
      return;
    }
    scrollToRow(Math.floor(index / columns));
    let frame = 0;
    const locate = (attempt: number) => {
      if (attempt > 12) {
        return;
      }
      frame = requestAnimationFrame(() => {
        const inner = scrollRef.current;
        const card = inner?.querySelector<HTMLElement>(
          `[data-photo-id="${memberId}"][role="option"]`
        );
        const outer = inner?.closest<HTMLElement>("[data-masonry-scroll]");
        if (!(inner && card && outer)) {
          if (attempt < 12) {
            locate(attempt + 1);
          }
          return;
        }
        const cardRect = card.getBoundingClientRect();
        const innerRect = inner.getBoundingClientRect();
        const innerTop = getReturnScrollTop({
          cardTop: inner.scrollTop + cardRect.top - innerRect.top,
          cardHeight: cardRect.height,
          clientHeight: inner.clientHeight,
          scrollTop: inner.scrollTop,
          topInset: 0,
        });
        if (applyReturnScroll(inner, innerTop)) {
          locate(attempt + 1);
          return;
        }
        const outerRect = outer.getBoundingClientRect();
        const paddingTop =
          Number.parseFloat(getComputedStyle(outer).paddingTop) || 0;
        const outerTop = getReturnScrollTop({
          cardTop: outer.scrollTop + cardRect.top - outerRect.top - paddingTop,
          cardHeight: cardRect.height,
          clientHeight: outer.clientHeight,
          scrollTop: outer.scrollTop,
          topInset,
        });
        if (applyReturnScroll(outer, outerTop)) {
          locate(attempt + 1);
          return;
        }
        card.focus({ preventScroll: true });
        completedRef.current = request;
        onLocatedRef.current?.(request);
      });
    };
    // Allow the virtualizer to publish the newly visible row before focusing it.
    locate(0);
    return () => cancelAnimationFrame(frame);
  }, [scrollRef, memberId, memberIds, columns, request, scrollToRow, topInset]);
}
