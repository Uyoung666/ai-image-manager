import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ComponentProps, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TOOLTIP_CONTENT_CLASS_NAME,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

function renderTooltip(props: ComponentProps<typeof Tooltip> = {}) {
  return render(
    <Tooltip delayDuration={30} disableHoverableContent {...props}>
      <TooltipTrigger asChild>
        <button type="button">提示按钮</button>
      </TooltipTrigger>
      <TooltipContent>统一提示内容</TooltipContent>
    </Tooltip>
  );
}

describe("Tooltip", () => {
  beforeEach(() => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

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
    const user = userEvent.setup();
    renderTooltip();

    await user.tab();

    expect(await screen.findByRole("tooltip")).toBeVisible();
  });

  it("closes the tooltip when the application window loses focus", async () => {
    const user = userEvent.setup();
    renderTooltip();

    await user.hover(screen.getByRole("button"));
    expect(await screen.findByRole("tooltip")).toBeVisible();

    fireEvent(window, new Event("blur"));

    await waitFor(() => {
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });
  });

  it("does not reopen on restored focus or unrelated pointer movement", async () => {
    const user = userEvent.setup();
    renderTooltip();
    const trigger = screen.getByRole("button");
    await user.click(trigger);

    fireEvent(window, new Event("blur"));
    fireEvent(window, new Event("focus"));
    fireEvent.focusIn(trigger);
    fireEvent.pointerMove(document.body, { pointerType: "mouse" });
    fireEvent.focusIn(trigger);

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    await user.unhover(trigger);
    await user.hover(trigger);
    expect(await screen.findByRole("tooltip")).toBeVisible();
    await user.unhover(trigger);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("blocks restored focus before React commits the window blur", () => {
    const onOpenChange = vi.fn();
    renderTooltip({ onOpenChange });
    const trigger = screen.getByRole("button");

    act(() => {
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("focus"));
      trigger.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });

    expect(onOpenChange).not.toHaveBeenCalledWith(true);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("rejects a pending hover after window blur even if the pointer moves elsewhere", async () => {
    vi.useFakeTimers();
    renderTooltip({ delayDuration: 400 });
    const trigger = screen.getByRole("button");
    fireEvent.pointerMove(trigger, { pointerType: "mouse" });
    fireEvent(window, new Event("blur"));
    fireEvent(window, new Event("focus"));
    fireEvent.pointerMove(document.body, { pointerType: "mouse" });

    await act(() => vi.advanceTimersByTimeAsync(500));

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("ignores hover and keyboard focus while the document is inactive", () => {
    vi.mocked(document.hasFocus).mockReturnValue(false);
    renderTooltip({ delayDuration: 0 });
    const trigger = screen.getByRole("button");

    fireEvent.pointerMove(trigger, { pointerType: "mouse" });
    fireEvent.keyDown(document, { key: "Tab" });
    fireEvent.focusIn(trigger);

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("allows a fresh hover after ignoring pointer movement in the background", async () => {
    vi.mocked(document.hasFocus).mockReturnValue(false);
    renderTooltip();
    const trigger = screen.getByRole("button");
    fireEvent.pointerMove(trigger, { pointerType: "mouse" });

    vi.mocked(document.hasFocus).mockReturnValue(true);
    fireEvent(window, new Event("focus"));
    fireEvent.pointerMove(trigger, { pointerType: "mouse" });

    expect(await screen.findByRole("tooltip")).toBeVisible();
  });

  it("keeps the tooltip closed after hiding and restoring the document", async () => {
    const user = userEvent.setup();
    const visibility = vi.spyOn(document, "visibilityState", "get");
    renderTooltip();
    await user.hover(screen.getByRole("button"));
    expect(await screen.findByRole("tooltip")).toBeVisible();

    visibility.mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    visibility.mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    fireEvent(window, new Event("focus"));
    fireEvent.focusIn(screen.getByRole("button"));
    fireEvent.focusIn(screen.getByRole("button"));

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it.each([
    "Tab",
    "ArrowDown",
  ])("allows keyboard navigation with %s after returning to the window", async (key) => {
    renderTooltip();
    fireEvent(window, new Event("blur"));
    fireEvent(window, new Event("focus"));
    fireEvent.keyDown(document, { key });
    fireEvent.focusIn(screen.getByRole("button"));

    expect(await screen.findByRole("tooltip")).toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("does not treat Alt+Tab as keyboard navigation inside the application", () => {
    renderTooltip();
    fireEvent(window, new Event("blur"));
    fireEvent(window, new Event("focus"));
    fireEvent.keyDown(document, { altKey: true, key: "Tab" });
    fireEvent.focusIn(screen.getByRole("button"));

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("closes controlled tooltips and only reopens them on fresh interaction", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    function ControlledTooltip() {
      const [open, setOpen] = useState(true);
      return (
        <Tooltip
          delayDuration={30}
          disableHoverableContent
          onOpenChange={(nextOpen) => {
            onOpenChange(nextOpen);
            setOpen(nextOpen);
          }}
          open={open}
        >
          <TooltipTrigger asChild>
            <button type="button">受控按钮</button>
          </TooltipTrigger>
          <TooltipContent>受控提示</TooltipContent>
        </Tooltip>
      );
    }
    render(<ControlledTooltip />);
    expect(await screen.findByRole("tooltip")).toBeVisible();

    fireEvent(window, new Event("blur"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    onOpenChange.mockClear();
    fireEvent(window, new Event("focus"));
    fireEvent.pointerMove(document.body, { pointerType: "mouse" });
    fireEvent.focusIn(screen.getByRole("button"));

    expect(onOpenChange).not.toHaveBeenCalledWith(true);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await user.hover(screen.getByRole("button"));
    expect(await screen.findByRole("tooltip")).toBeVisible();
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });
});
