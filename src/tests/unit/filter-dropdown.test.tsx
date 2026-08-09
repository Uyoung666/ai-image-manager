import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  FILTER_DROPDOWN_CLASS_NAME,
  FilterDropdown,
} from "@/components/filter-dropdown";

const options = [
  { label: "First option", value: "first" },
  { label: "Second option", value: "second" },
  { label: "Third option", value: "third" },
];

function renderDropdown(
  overrides: Partial<ComponentProps<typeof FilterDropdown>> = {}
) {
  return render(
    <FilterDropdown
      ariaLabel="Choose an option"
      onChange={vi.fn()}
      options={options}
      placeholder="Choose an option"
      value="first"
      {...overrides}
    />
  );
}

describe("FilterDropdown", () => {
  it("uses the shared standard appearance and accessible combobox state", () => {
    const { container } = renderDropdown();
    const input = screen.getByRole("combobox", { name: "Choose an option" });

    expect(input).toHaveClass(...FILTER_DROPDOWN_CLASS_NAME.split(" "));
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).toHaveAttribute("aria-haspopup", "listbox");
    expect(input).not.toHaveAttribute("aria-controls");

    fireEvent.click(input);

    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).toHaveAttribute("aria-controls");
    const listbox = screen.getByRole("listbox");
    expect(listbox).toBeInTheDocument();
    expect(container).not.toContainElement(listbox);
    expect(listbox).toHaveClass("max-w-[calc(100vw-1rem)]", "overflow-y-auto");
  });

  it("selects an option by click and closes the list", () => {
    const onChange = vi.fn();
    renderDropdown({ onChange });
    const input = screen.getByRole("combobox");

    fireEvent.click(input);
    fireEvent.click(screen.getByRole("option", { name: "Second option" }));

    expect(onChange).toHaveBeenCalledWith("second");
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  it("closes when the already-open input is clicked again", async () => {
    const user = userEvent.setup();
    renderDropdown();
    const input = screen.getByRole("combobox");

    await user.click(input);
    expect(input).toHaveAttribute("aria-expanded", "true");

    await user.click(input);
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  it("opens on focus and still closes with Escape", () => {
    renderDropdown();
    const input = screen.getByRole("combobox");

    fireEvent.focus(input);
    expect(input).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  it("supports keyboard navigation, Home/End, Enter and Escape", () => {
    const onChange = vi.fn();
    renderDropdown({ onChange });
    const input = screen.getByRole("combobox");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).toHaveAttribute("aria-activedescendant");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("second");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "End" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith("third");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  it("filters editable options and honors disabled state", () => {
    const disabled = renderDropdown({
      disabled: true,
      editable: true,
      value: "",
    });
    const input = screen.getByRole("combobox");

    expect(input).toBeDisabled();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    disabled.unmount();
    renderDropdown({ editable: true, value: "sec" });
    const editableInput = screen.getByRole("combobox");
    fireEvent.click(editableInput);

    expect(
      screen.getByRole("option", { name: "Second option" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "First option" })
    ).not.toBeInTheDocument();
  });

  it("renders optional color swatches and a selected check", () => {
    renderDropdown({
      options: [
        { color: "#B4B4B4", label: "Default", value: "default" },
        { color: "#F077AF", label: "Pink", value: "pink" },
      ],
      showOptionColors: true,
      showSelectedCheck: true,
      value: "pink",
    });

    fireEvent.click(screen.getByRole("combobox"));

    expect(screen.getByRole("option", { name: "Pink" })).toHaveTextContent(
      "Pink"
    );
    expect(screen.getByRole("option", { name: "Pink" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(
      screen
        .getByRole("option", { name: "Pink" })
        .querySelector('[aria-hidden="true"]')
    ).toBeInTheDocument();
  });
});
