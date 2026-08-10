import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { KeyboardShortcuts } from "@/components/KeyboardShortcuts";

describe("KeyboardShortcuts responsive layout", () => {
  it("keeps the dialog shorter and fades the scrollable content bottom", () => {
    render(<KeyboardShortcuts onClose={vi.fn()} open />);

    const dialog = screen.getByRole("dialog");
    const scrollContainer = dialog.querySelector(
      ".resource-tree-scroll"
    ) as HTMLDivElement | null;

    expect(dialog).toHaveClass(
      "max-h-[calc(100dvh-5rem)]",
      "min-h-0",
      "overflow-hidden",
      "flex",
      "flex-col"
    );
    expect(scrollContainer).not.toBeNull();
    expect(scrollContainer).toHaveClass(
      "min-h-0",
      "flex-1",
      "overflow-y-auto",
      "overscroll-contain"
    );

    Object.defineProperties(scrollContainer, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, value: 0 },
    });
    fireEvent.scroll(scrollContainer as HTMLDivElement);

    expect(scrollContainer).toHaveAttribute("data-bottom-fade", "true");
  });
});
