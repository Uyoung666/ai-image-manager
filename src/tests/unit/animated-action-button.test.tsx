import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AnimatedActionButton } from "@/components/ui/animated-action-button";

describe("AnimatedActionButton", () => {
  it("uses a native button contract and keeps its accessible name", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <AnimatedActionButton
        icon={<span data-testid="static-icon">archive</span>}
        onClick={onClick}
      >
        Send
      </AnimatedActionButton>
    );

    const button = screen.getByRole("button", { name: "Send" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).not.toHaveAttribute("aria-busy");
    expect(screen.getByTestId("static-icon").parentElement).toHaveAttribute(
      "aria-hidden",
      "true"
    );
    expect(
      button.querySelector(".animated-action-button__plane")
    ).toHaveAttribute("aria-hidden", "true");

    await user.click(button);
    button.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(3);
  });

  it("disables interaction and animation while loading", () => {
    render(<AnimatedActionButton loading>Saving</AnimatedActionButton>);

    const button = screen.getByRole("button", { name: "Saving" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("data-loading", "true");
  });
});
