import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SearchCompletionNotice } from "@/components/SearchCompletionNotice";

describe("partial search results notice", () => {
  it.each([
    720, 900, 1280,
  ])("keeps a wrapping status and accessible retry at %i px", (width) => {
    const retry = vi.fn();
    const { unmount } = render(
      <div style={{ width }}>
        <SearchCompletionNotice onRetry={retry} />
      </div>
    );
    expect(screen.getByRole("status")).toHaveClass("flex-wrap", "min-w-0");
    fireEvent.click(screen.getByRole("button"));
    expect(retry).toHaveBeenCalledOnce();
    unmount();
  });

  it("keeps the inline message readable and exposes a single retry action", () => {
    const retry = vi.fn();
    render(<SearchCompletionNotice inline onRetry={retry} />);

    const status = screen.getByRole("status");
    expect(status).not.toHaveClass("border-b", "flex-wrap");
    expect(status.querySelector('[data-slot="tooltip-trigger"]')).toHaveClass(
      "truncate"
    );
    expect(
      status.querySelector('[data-slot="tooltip-trigger"]')
    ).toHaveAttribute("tabindex", "0");
    fireEvent.click(screen.getByRole("button"));
    expect(retry).toHaveBeenCalledOnce();
  });
});
