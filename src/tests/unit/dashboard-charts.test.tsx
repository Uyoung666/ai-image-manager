import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ChartSection,
  CoverageCard,
  DashboardBarChart,
} from "@/components/dashboard/dashboard-charts";

describe("dashboard chart accessibility", () => {
  it("exposes chart values through a keyboard-operable data table", () => {
    const onPointClick = vi.fn();
    render(
      <ChartSection
        data={[{ count: 3, name: "Example camera" }]}
        onPointClick={onPointClick}
        sampleTotal={4}
        title="Camera usage"
      >
        <div>chart</div>
      </ChartSection>
    );

    fireEvent.click(screen.getByRole("button", { name: "dashboardViewData" }));
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("75.0%")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Example camera" }));
    expect(onPointClick).toHaveBeenCalledWith({
      count: 3,
      name: "Example camera",
    });
  });

  it("renders coverage as a bounded progress indicator", () => {
    const { container } = render(
      <CoverageCard count={12} label="EXIF" percentage={75} />
    );
    expect(screen.getByText("75%")).toBeInTheDocument();
    expect(screen.getByText("dashboardCoveragePartial")).toBeInTheDocument();
    expect(container.querySelector('[style*="width: 75%"]')).not.toBeNull();
  });

  it("renders every gear category as its own horizontal bar", () => {
    const onPointClick = vi.fn();
    const { container } = render(
      <DashboardBarChart
        data={[
          { count: 76, name: "Canon EOS 600D" },
          { count: 9, name: "Canon EOS R7" },
          { count: 6, name: "OPPO Find X6" },
        ]}
        horizontal
        onPointClick={onPointClick}
        sampleTotal={91}
      />
    );

    const bars = screen.getAllByRole("listitem");
    expect(bars).toHaveLength(3);
    expect(
      container.querySelector('[style*="width 400ms ease-out"]')
    ).not.toBeNull();
    expect(within(bars[0]).getByText("83.5%")).toBeInTheDocument();
    fireEvent.click(within(bars[1]).getByRole("button"));
    expect(onPointClick).toHaveBeenCalledWith({
      count: 9,
      name: "Canon EOS R7",
    });
  });

  it("disables horizontal bar motion when reduced motion is requested", () => {
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: true }) as MediaQueryList),
    });
    const { container } = render(
      <DashboardBarChart
        data={[{ count: 5, name: "Manual" }]}
        horizontal
        sampleTotal={5}
      />
    );

    expect(
      container.querySelector('[style*="width 400ms ease-out"]')
    ).toBeNull();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
  });

  it("keeps zero-count data points non-interactive", () => {
    const onPointClick = vi.fn();
    render(
      <ChartSection
        data={[{ count: 0, name: "Empty period" }]}
        onPointClick={onPointClick}
        sampleTotal={0}
        title="Time"
      >
        <div>chart</div>
      </ChartSection>
    );

    fireEvent.click(screen.getByRole("button", { name: "dashboardViewData" }));
    expect(screen.queryByRole("button", { name: "Empty period" })).toBeNull();
    expect(screen.getByText("Empty period")).toBeInTheDocument();
    expect(onPointClick).not.toHaveBeenCalled();
  });
});
