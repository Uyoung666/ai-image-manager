import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CalendarHeatmap } from "@/components/dashboard/calendar-heatmap";

describe("CalendarHeatmap", () => {
  it("renders daily activity as an accessible, drillable cell", () => {
    const onDateClick = vi.fn();
    render(
      <CalendarHeatmap
        data={[{ count: 7, date: "2026-07-24" }]}
        now={new Date(2026, 6, 24)}
        onDateClick={onDateClick}
      />
    );

    expect(screen.getByTestId("calendar-heatmap")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button").at(-1) as HTMLElement);
    expect(onDateClick).toHaveBeenCalledWith("2026-07-24");
  });

  it("does not render a heatmap without dated activity", () => {
    const { container } = render(
      <CalendarHeatmap data={[]} onDateClick={vi.fn()} />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("keeps zero-count dates visible but non-interactive", () => {
    render(
      <CalendarHeatmap
        data={[{ count: 0, date: "2026-07-24" }]}
        now={new Date(2026, 6, 24)}
        onDateClick={vi.fn()}
      />
    );

    expect(screen.queryByRole("button")).toBeNull();
  });
});
