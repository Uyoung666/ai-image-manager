import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { useModalFocusTrap } from "@/hooks/use-modal-focus-trap";

function FocusTrapHarness({ onEscape }: { onEscape: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap({ active: true, containerRef, onEscape });

  return (
    <div ref={containerRef}>
      <button type="button">first</button>
      <button type="button">last</button>
    </div>
  );
}

describe("useModalFocusTrap", () => {
  it("handles Escape and wraps keyboard focus inside the overlay", () => {
    const onEscape = vi.fn();
    const rects = vi
      .spyOn(HTMLElement.prototype, "getClientRects")
      .mockReturnValue({ length: 1 } as DOMRectList);
    render(<FocusTrapHarness onEscape={onEscape} />);

    const first = screen.getByRole("button", { name: "first" });
    const last = screen.getByRole("button", { name: "last" });
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(first).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onEscape).toHaveBeenCalledOnce();
    rects.mockRestore();
  });
});
