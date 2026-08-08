import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  TOOLTIP_CONTENT_CLASS_NAME,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

function renderTooltip() {
  return render(
    <Tooltip disableHoverableContent>
      <TooltipTrigger asChild>
        <button type="button">提示按钮</button>
      </TooltipTrigger>
      <TooltipContent>统一提示内容</TooltipContent>
    </Tooltip>
  );
}

describe("Tooltip", () => {
  it("shows the shared tooltip on hover and hides it after unhover", async () => {
    const user = userEvent.setup();
    renderTooltip();

    const trigger = screen.getByRole("button", { name: "提示按钮" });
    await user.hover(trigger);

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("统一提示内容");
    const tooltipContent = tooltip.closest('[data-slot="tooltip-content"]');
    expect(tooltipContent).not.toBeNull();
    expect(tooltipContent).toHaveAttribute("data-slot", "tooltip-content");
    expect(tooltipContent).toHaveClass(
      ...TOOLTIP_CONTENT_CLASS_NAME.split(" ")
    );

    await user.unhover(trigger);
    fireEvent.pointerLeave(trigger);
    fireEvent.blur(trigger);
    await waitFor(() => {
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });
  });

  it("shows the tooltip when the trigger receives keyboard focus", async () => {
    renderTooltip();

    screen.getByRole("button", { name: "提示按钮" }).focus();

    expect(await screen.findByRole("tooltip")).toBeVisible();
  });
});
