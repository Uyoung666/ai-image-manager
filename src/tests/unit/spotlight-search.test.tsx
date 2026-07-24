import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpotlightSearch } from "@/components/SpotlightSearch";

const { navigateMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
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
  useAiStatus: () => ({ data: { coverageState: "ready" } }),
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
    expect(screen.queryByText("settingsStorage")).not.toBeInTheDocument();
  });
});
