import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSidebarFilter } from "@/contexts/SidebarFilterContext";
import { RootSurface } from "@/routes/__root";

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/utils/progress-phrases", () => ({
  getRandomPhrase: () => "",
}));

function SidebarFilterProbe() {
  const filter = useSidebarFilter();
  return (
    <output data-testid="sidebar-filter-ready">
      {String(filter.collapsed)}
    </output>
  );
}

describe("RootSurface", () => {
  it("keeps SidebarFilterProvider around the standalone update screen", () => {
    render(
      <RootSurface pathname="/whats-new">
        <SidebarFilterProbe />
      </RootSurface>
    );

    expect(screen.getByTestId("sidebar-filter-ready")).toBeInTheDocument();
  });
});
