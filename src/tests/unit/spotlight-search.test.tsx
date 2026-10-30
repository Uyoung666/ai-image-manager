import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpotlightSearch } from "@/components/SpotlightSearch";

const { navigateMock, aiStatusMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  aiStatusMock: { coverageState: "ready", rebuildRequired: false },
}));

class ResizeObserverMock {
  disconnect() {
    return undefined;
  }
  observe() {
    return undefined;
  }
  unobserve() {
    return undefined;
  }
}

vi.stubGlobal("ResizeObserver", ResizeObserverMock);
Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  value: vi.fn(),
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("@/hooks/useAiStatus", () => ({
  useAiStatus: () => ({ data: aiStatusMock }),
}));

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      albums: { listAlbums: vi.fn().mockResolvedValue([]) },
      faces: { listFaceIdentities: vi.fn().mockResolvedValue([]) },
      photos: {
        getTags: vi.fn().mockResolvedValue([]),
        searchSpotlight: vi.fn().mockResolvedValue({ results: [] }),
      },
    },
  },
}));

describe("SpotlightSearch", () => {
  beforeEach(() => {
    navigateMock.mockReset();
    aiStatusMock.coverageState = "ready";
    aiStatusMock.rebuildRequired = false;
  });

  it("offers rebuild guidance before a query and closes the overlay on keyboard navigation", async () => {
    aiStatusMock.coverageState = "error";
    aiStatusMock.rebuildRequired = true;
    render(<SpotlightSearch />);
    fireEvent.keyDown(document, { ctrlKey: true, key: "k" });
    expect(
      screen.getByRole("alert", { name: "aiIndexRebuildRequired" })
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByPlaceholderText("spotlightSearchPlaceholder")
      ).toHaveFocus()
    );
    screen.getByRole("button", { name: "aiIndexOpenSettings" }).focus();
    await userEvent.setup().keyboard("{Enter}");
    expect(navigateMock).toHaveBeenCalledWith({ to: "/settings/ai-index" });
    expect(
      screen.queryByPlaceholderText("spotlightSearchPlaceholder")
    ).toBeNull();
  });

  it("finds settings by their existing keywords and navigates directly", async () => {
    render(<SpotlightSearch />);

    fireEvent.keyDown(document, { ctrlKey: true, key: "k" });
    fireEvent.change(
      screen.getByPlaceholderText("spotlightSearchPlaceholder"),
      {
        target: { value: "thumbnail" },
      }
    );

    const storageSetting = await screen.findByText("settingsStorage");
    fireEvent.click(storageSetting);

    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith({ to: "/settings/storage" })
    );
    expect(
      screen.queryByPlaceholderText("spotlightSearchPlaceholder")
    ).not.toBeInTheDocument();
  });

  it("keeps the single settings navigation entry when the query is empty", () => {
    render(<SpotlightSearch />);

    fireEvent.keyDown(document, { ctrlKey: true, key: "k" });

    expect(screen.getByText("设置")).toBeInTheDocument();
    expect(
      document.querySelector("[data-animated-icon='chart-line']")
    ).toBeInTheDocument();
    expect(screen.queryByText("settingsStorage")).not.toBeInTheDocument();
  });
});
