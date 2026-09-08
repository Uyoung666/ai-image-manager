import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useImportDropContext } from "@/contexts/import-drop-context";
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

function ImportDropProbe() {
  const { registerImageSearch } = useImportDropContext();
  return (
    <output data-testid="import-drop-ready">
      {typeof registerImageSearch === "function" ? "ready" : "missing"}
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

  it("provides ImportDropProvider to the standalone update screen", () => {
    render(
      <RootSurface pathname="/whats-new">
        <ImportDropProbe />
      </RootSurface>
    );

    expect(screen.getByTestId("import-drop-ready")).toHaveTextContent("ready");
  });
});
