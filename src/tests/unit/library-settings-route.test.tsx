import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Route } from "@/routes/settings.library";

const state = vi.hoisted(() => ({
  search: {} as {
    photoId?: number;
    folderId?: number;
    status?: string;
    tab?: string;
  },
  navigate: vi.fn(),
  getHealth: vi.fn(),
  getPhotos: vi.fn(),
  getActiveTask: vi.fn(),
  getTask: vi.fn(),
  cancelTask: vi.fn(),
  reconcile: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({
    options,
    useSearch: () => state.search,
    useNavigate: () => state.navigate,
  }),
}));
vi.mock("@/actions/library-reliability", () => ({
  libraryReliabilityActions: state,
}));
vi.mock("@/components/LibrarySettingsPhoto", () => ({
  LibrarySettingsPhoto: ({
    photo,
    onCheck,
    checkState,
  }: {
    photo: { filename: string };
    onCheck: () => void;
    checkState?: string;
  }) => (
    <article>
      {photo.filename}
      <button onClick={onCheck} type="button">
        Check original file
      </button>
      {checkState && <span>{checkState}</span>}
    </article>
  ),
}));
vi.mock("@/components/LibraryRelinkPreview", () => ({
  LibraryRelinkPreview: () => <section>relink-preview</section>,
}));
let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  state.search = {};
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  state.getHealth.mockResolvedValue({
    total: 2,
    attentionCount: 1,
    folders: [],
  });
  state.getPhotos.mockResolvedValue({
    total: 0,
    offset: 0,
    limit: 20,
    items: [],
  });
  state.getActiveTask.mockResolvedValue(null);
});
afterEach(() => {
  cleanup();
  client.clear();
});
function mount() {
  const Page = Route.options.component as ComponentType;
  return render(
    <QueryClientProvider client={client}>
      <Page />
    </QueryClientProvider>
  );
}
it("opens the requested photo directly even when default attention filtering excludes it", async () => {
  state.search = { photoId: 7 };
  state.getPhotos.mockResolvedValue({
    total: 1,
    offset: 0,
    limit: 20,
    items: [{ id: 7, filename: "restored.jpg" }],
  });
  mount();
  await screen.findByText("restored.jpg");
  expect(state.getPhotos).toHaveBeenCalledWith(
    expect.objectContaining({ photoId: 7, status: "attention" })
  );
});
it("discovers and cancels a check that began before entering settings", async () => {
  const task = {
    taskId: "existing",
    status: "running",
    kind: "check",
    phase: "checking",
    scope: {},
    cancellable: true,
    processed: 1,
    total: 20,
    errors: [],
    errorDetails: [],
    errorCount: 0,
  };
  state.getActiveTask.mockResolvedValue(task);
  state.cancelTask.mockResolvedValue({
    ...task,
    status: "cancelled",
    cancellable: false,
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "cancel" }));
  await waitFor(() =>
    expect(state.cancelTask).toHaveBeenCalledWith("existing")
  );
});
it("shows affected roots without duplicate child cards or status filters", async () => {
  state.getHealth.mockResolvedValue({
    total: 2,
    attentionCount: 1,
    offlineCount: 0,
    folders: [
      {
        id: 1,
        parentId: null,
        displayName: "Root",
        path: "D:/photos",
        attentionCount: 1,
        unavailable: 1,
        offlineCount: 0,
        sourceStatus: "available",
      },
      {
        id: 2,
        parentId: 1,
        displayName: "Child",
        path: "D:/photos/child",
        attentionCount: 1,
        unavailable: 1,
        offlineCount: 0,
        sourceStatus: "missing",
      },
    ],
  });
  mount();
  await screen.findByText("Root");
  expect(screen.queryByText("Child")).not.toBeInTheDocument();
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(state.getPhotos).not.toHaveBeenCalled();
});
