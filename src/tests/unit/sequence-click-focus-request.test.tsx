import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useSequenceClickFocusRequest } from "@/hooks/useSequenceClickFocusRequest";

function mouseClick(options: MouseEventInit = {}) {
  return new MouseEvent("click", {
    detail: 1,
    ...options,
  }) as unknown as React.MouseEvent;
}

describe("sequence click focus requests", () => {
  it("tracks the latest sequence or member and repeats clicks with a new request", () => {
    const { result } = renderHook(() => useSequenceClickFocusRequest());
    act(() => result.current.requestSequenceFocus(7, null, mouseClick()));
    expect(result.current.sequenceFocusRequest).toEqual({
      id: 1,
      sequenceId: 7,
      memberId: null,
    });
    act(() => result.current.requestSequenceFocus(7, null, mouseClick()));
    expect(result.current.sequenceFocusRequest?.id).toBe(2);
    act(() => result.current.requestSequenceFocus(8, 30, mouseClick()));
    expect(result.current.sequenceFocusRequest).toEqual({
      id: 3,
      sequenceId: 8,
      memberId: 30,
    });
    act(() => result.current.clearSequenceFocus());
    expect(result.current.sequenceFocusRequest).toBeNull();
  });

  it.each([
    "ctrlKey",
    "metaKey",
    "shiftKey",
    "altKey",
  ] as const)("clears pending focus when opening details with %s", (modifier) => {
    const { result } = renderHook(() => useSequenceClickFocusRequest());
    act(() => result.current.requestSequenceFocus(7, null, mouseClick()));
    act(() =>
      result.current.requestSequenceFocus(
        8,
        null,
        mouseClick({ [modifier]: true })
      )
    );
    expect(result.current.sequenceFocusRequest).toBeNull();
  });

  it("does not center keyboard, programmatic, or absent events", () => {
    const { result } = renderHook(() => useSequenceClickFocusRequest());
    act(() => result.current.requestSequenceFocus(7, null, mouseClick()));
    act(() =>
      result.current.requestSequenceFocus(7, null, mouseClick({ detail: 0 }))
    );
    expect(result.current.sequenceFocusRequest).toBeNull();
    act(() => result.current.requestSequenceFocus(7, null));
    expect(result.current.sequenceFocusRequest).toBeNull();
    act(() => result.current.requestSequenceFocus(7, null, mouseClick()));
    act(() =>
      result.current.requestSequenceFocus(
        7,
        null,
        new MouseEvent("keydown", { detail: 1 }) as unknown as React.MouseEvent
      )
    );
    expect(result.current.sequenceFocusRequest).toBeNull();
  });
});
