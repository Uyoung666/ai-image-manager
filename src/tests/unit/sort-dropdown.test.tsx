import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SortDropdown } from "@/components/SortDropdown";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe("SortDropdown", () => {
  it("preserves the sort field/order callback while using FilterDropdown", () => {
    const onChange = vi.fn();
    render(<SortDropdown onChange={onChange} order="desc" sort="date" />);

    const dropdown = screen.getByRole("combobox", { name: "sortBy" });
    expect(dropdown).toHaveValue("sortDateDesc");

    fireEvent.click(dropdown);
    fireEvent.click(screen.getByRole("option", { name: "sortNameAsc" }));

    expect(onChange).toHaveBeenCalledWith("name", "asc");
  });
});
