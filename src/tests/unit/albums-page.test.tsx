import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AlbumsPage } from "@/routes/albums";

const mocks = vi.hoisted(() => ({
  createAlbum: vi.fn(),
  listAlbums: vi.fn(),
}));

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      albums: mocks,
    },
  },
}));

vi.mock("@/components/SmartAlbumDialog", () => ({
  SmartAlbumDialog: () => null,
}));

vi.mock("@/hooks/useRouteScrollRestoration", () => ({
  useRouteScrollRestoration: () => undefined,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: ReactNode }) => (
    <a href="/albums">{children}</a>
  ),
  Outlet: () => null,
  createFileRoute: () => (options: unknown) => options,
  useMatch: () => null,
  useNavigate: () => vi.fn(),
}));

describe("AlbumsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a retryable error instead of the empty state when loading fails", async () => {
    mocks.listAlbums
      .mockRejectedValueOnce(new Error("load failed"))
      .mockResolvedValueOnce([]);

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <AlbumsPage />
      </QueryClientProvider>
    );

    expect(await screen.findByText("加载失败，请重试")).toBeInTheDocument();
    expect(screen.queryByText("noAlbumsTitle")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "retry" }));

    await waitFor(() => expect(mocks.listAlbums).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("noAlbumsTitle")).toBeInTheDocument();
  });

  it("renders cached albums immediately when revisiting within the stale window", async () => {
    mocks.listAlbums.mockResolvedValue([
      {
        coverPhotoId: null,
        createdAt: 1,
        description: null,
        id: 1,
        isSmart: false,
        name: "Cached album",
      },
    ]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <AlbumsPage />
      </QueryClientProvider>
    );

    expect(await screen.findByText("Cached album")).toBeInTheDocument();
    view.unmount();
    render(
      <QueryClientProvider client={client}>
        <AlbumsPage />
      </QueryClientProvider>
    );

    expect(screen.getByText("Cached album")).toBeInTheDocument();
    expect(mocks.listAlbums).toHaveBeenCalledTimes(1);
  });
});
