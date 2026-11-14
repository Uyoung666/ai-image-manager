import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { useModalFocusTrap } from "@/hooks/use-modal-focus-trap";

function FocusTrapHarness({
  onEscape,
  initialFocus,
  respectNestedOverlays,
}: {
  onEscape: () => void;
  respectNestedOverlays?: boolean;
  initialFocus?: "first" | "container";
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap({
    active: true,
    containerRef,
    onEscape,
    initialFocus,
    respectNestedOverlays,
  });

  return (
    <div data-testid="focus-surface" ref={containerRef} tabIndex={-1}>
      <button type="button">first</button>
      <button type="button">last</button>
    </div>
  );
}

describe("useModalFocusTrap", () => {
  it("starts on the container and supports Tab and Shift+Tab from the surface", async () => {
    const rects = vi
      .spyOn(HTMLElement.prototype, "getClientRects")
      .mockReturnValue({ length: 1 } as DOMRectList);
    try {
      render(<FocusTrapHarness initialFocus="container" onEscape={vi.fn()} />);
      const surface = screen.getByTestId("focus-surface");
      await waitFor(() => expect(surface).toHaveFocus());
      fireEvent.keyDown(surface, { key: "Tab" });
      expect(screen.getByRole("button", { name: "first" })).toHaveFocus();
      surface.focus();
      fireEvent.keyDown(surface, { key: "Tab", shiftKey: true });
      expect(screen.getByRole("button", { name: "last" })).toHaveFocus();
    } finally {
      rects.mockRestore();
    }
  });
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

it("lets nested portal overlays handle Escape and Tab before the inspector", () => {
  const onEscape = vi.fn();
  const { unmount } = render(
    <FocusTrapHarness onEscape={onEscape} respectNestedOverlays />
  );
  const portal = document.createElement("div");
  portal.dataset.slot = "popover-content";
  portal.dataset.state = "open";
  document.body.append(portal);
  try {
    const escapeEvent = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    portal.dispatchEvent(escapeEvent);
    expect(escapeEvent.defaultPrevented).toBe(false);
    expect(onEscape).not.toHaveBeenCalled();
    const tab = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    portal.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    portal.dataset.state = "closed";
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onEscape).toHaveBeenCalledOnce();
  } finally {
    portal.remove();
    unmount();
  }
});
