import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SearchTextButton } from "@/features/search-bar/SearchTextButton";

function setLabelWidth(
  element: HTMLElement,
  scrollWidth: number,
  clientWidth: number
) {
  Object.defineProperties(element, {
    scrollWidth: { configurable: true, value: scrollWidth },
    clientWidth: { configurable: true, value: clientWidth },
  });
}

describe("search text tooltip restraint", () => {
  it("recognizes vertically clipped two-line card titles", async () => {
    const user = userEvent.setup();
    render(
      <SearchTextButton tooltipText="A long two-line theme">
        <span data-search-tooltip-text>A long two-line theme</span>
      </SearchTextButton>
    );
    const label = screen.getByText("A long two-line theme");
    setLabelWidth(label, 100, 100);
    Object.defineProperties(label, {
      scrollHeight: { value: 68 },
      clientHeight: { value: 34 },
    });
    await user.hover(screen.getByRole("button"));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "A long two-line theme"
    );
  });
  it("shows full text on hover and keyboard focus only when the label is truncated", async () => {
    const user = userEvent.setup();
    render(
      <SearchTextButton tooltipText="A long recommendation">
        {" "}
        <span data-search-tooltip-text>A long recommendation</span>{" "}
      </SearchTextButton>
    );
    const label = screen.getByText("A long recommendation");
    const button = screen.getByRole("button");
    setLabelWidth(label, 240, 100);
    await user.hover(button);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "A long recommendation"
    );
    await user.unhover(button);
    act(() => button.focus());
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "A long recommendation"
    );
    act(() => button.blur());
    setLabelWidth(label, 240, 300);
    act(() => button.focus());
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("does not show a tooltip for a fully visible recommendation", async () => {
    const user = userEvent.setup();
    render(
      <SearchTextButton tooltipText="Beach">
        <span data-search-tooltip-text>Beach</span>
      </SearchTextButton>
    );
    setLabelWidth(screen.getByText("Beach"), 60, 120);
    const button = screen.getByRole("button");
    act(() => button.focus());
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await user.hover(button);
    await act(() => new Promise((resolve) => setTimeout(resolve, 500)));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("keeps history buttons free of tooltip behavior even if the text overflows", async () => {
    const user = userEvent.setup();
    render(
      <SearchTextButton aria-label="Long search history">
        <span data-search-tooltip-text>Long search history</span>
      </SearchTextButton>
    );
    setLabelWidth(screen.getByText("Long search history"), 400, 80);
    const button = screen.getByRole("button");
    expect(button).not.toHaveAttribute("data-slot", "tooltip-trigger");
    expect(button).not.toHaveAttribute("title");
    act(() => button.focus());
    await user.hover(button);
    await act(() => new Promise((resolve) => setTimeout(resolve, 500)));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
