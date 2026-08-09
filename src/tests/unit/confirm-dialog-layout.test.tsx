import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "@/components/ConfirmDialog";

describe("ConfirmDialog responsive layout", () => {
  it("keeps long action labels inside a viewport-safe dialog", () => {
    render(
      <ConfirmDialog
        confirmText="Reset all face recognition results"
        description="This intentionally uses long localized copy."
        onConfirm={vi.fn()}
        open
        title="Reset recognition?"
      />
    );

    const dialog = screen.getByRole("alertdialog");
    const confirm = screen.getByRole("button", {
      name: "Reset all face recognition results",
    });
    const footer = confirm.parentElement;

    expect(dialog).toHaveClass(
      "w-[calc(100%-2rem)]",
      "data-[size=sm]:max-w-sm",
      "max-h-[calc(100dvh-2rem)]",
      "overflow-y-auto"
    );
    expect(footer).toHaveClass("sm:flex-wrap");
    expect(confirm).toHaveClass("min-w-0", "whitespace-normal", "text-center");
  });
});
