import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBrowseSession } from "@/contexts/BrowseSessionContext";
import { useImportDropContext } from "@/contexts/import-drop-context";
import { useSidebarFilter } from "@/contexts/SidebarFilterContext";
import { RootSurface } from "@/routes/__root";

vi.mock("@/layouts/base-layout", () => ({
  default: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

beforeEach(() => sessionStorage.clear());

function BrowseProbe() {
  const { getSession, saveSession } = useBrowseSession();
  return (
    <button
      onClick={() => saveSession("/", { selectedIds: [42] })}
      type="button"
    >
      {getSession("/").selectedIds.join(",") || "empty"}
    </button>
  );
}

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
  it("supports an old browse consumer while the layout has switched to whats-new", () => {
    render(
      <RootSurface pathname="/whats-new">
        <BrowseProbe />
      </RootSurface>
    );
    expect(screen.getByRole("button", { name: "empty" })).toBeInTheDocument();
  });

  it("preserves the same session across ordinary and standalone layouts", () => {
    const view = render(
      <RootSurface pathname="/">
        <BrowseProbe />
      </RootSurface>
    );
    fireEvent.click(screen.getByRole("button", { name: "empty" }));
    // Verify the in-memory cache survives, not just sessionStorage restoration.
    sessionStorage.clear();
    for (const pathname of ["/whats-new", "/", "/people", "/albums/1"]) {
      view.rerender(
        <RootSurface pathname={pathname}>
          <BrowseProbe />
        </RootSurface>
      );
      expect(screen.getByRole("button", { name: "42" })).toBeInTheDocument();
    }
  });
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
