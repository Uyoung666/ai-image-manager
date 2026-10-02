import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSequenceReturnFocus } from "@/hooks/useSequenceReturnFocus";

const memberIds = Array.from({ length: 100 }, (_, index) => index + 1);
const scrollToRow = vi.fn();
const onLocated = vi.fn();

function Harness({
  request,
  renderCard = true,
}: {
  request: number;
  renderCard?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useSequenceReturnFocus({
    scrollRef,
    memberId: 80,
    memberIds,
    columns: 4,
    request,
    scrollToRow,
    onLocated,
    topInset: 48,
  });
  return (
    <div data-masonry-scroll="">
      <div ref={scrollRef}>
        {renderCard && (
          <div
            aria-selected={false}
            data-photo-id="80"
            role="option"
            tabIndex={0}
          />
        )}
      </div>
    </div>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  scrollToRow.mockClear();
  onLocated.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("sequence return focus", () => {
  it("locates a virtual row, focuses its member and completes only once", () => {
    const { container, rerender } = render(<Harness request={1} />);
    expect(scrollToRow).toHaveBeenCalledWith(19);
    act(() => vi.advanceTimersByTime(40));
    expect(document.activeElement).toBe(
      container.querySelector('[data-photo-id="80"]')
    );
    expect(onLocated).toHaveBeenCalledExactlyOnceWith(1);
    rerender(<Harness request={1} />);
    act(() => vi.advanceTimersByTime(40));
    expect(onLocated).toHaveBeenCalledTimes(1);
  });
  it("waits for the target row to mount before completion", () => {
    const { rerender } = render(<Harness renderCard={false} request={1} />);
    act(() => vi.advanceTimersByTime(32));
    expect(onLocated).not.toHaveBeenCalled();
    rerender(<Harness request={1} />);
    act(() => vi.advanceTimersByTime(40));
    expect(onLocated).toHaveBeenCalledExactlyOnceWith(1);
  });
  it("cancels pending focus when the request is cleared", () => {
    const { rerender } = render(<Harness request={1} />);
    rerender(<Harness request={0} />);
    act(() => vi.advanceTimersByTime(200));
    expect(onLocated).not.toHaveBeenCalled();
  });
  it("does not alter selection when focusing", () => {
    const { container } = render(<Harness request={1} />);
    act(() => vi.advanceTimersByTime(40));
    expect(container.querySelector('[data-photo-id="80"]')).toHaveAttribute(
      "aria-selected",
      "false"
    );
  });
});
