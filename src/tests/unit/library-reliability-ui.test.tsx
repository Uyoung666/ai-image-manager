import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  readSearchPresets,
  writeSearchPresets,
} from "@/actions/search-presets";
import { LibraryHealthDialog } from "@/components/LibraryHealthDialog";
import { LibraryPhotoControls } from "@/components/LibraryPhotoControls";
import { LibraryPhotoStatusBadge } from "@/components/LibraryPhotoStatus";
import { LibraryRelinkButton } from "@/components/LibraryRelinkButton";
import { buildSearchFilterParams } from "@/utils/search-filter-params";

const REMOVAL_LINKS = /libraryReliability.removeLinks/;

const actions = vi.hoisted(() => ({
  getHealth: vi.fn(),
  getIssues: vi
    .fn()
    .mockResolvedValue({ total: 0, offset: 0, limit: 20, items: [] }),
  reconcile: vi.fn(),
  getTask: vi.fn(),
  cancelTask: vi.fn(),
  inspectPhotoRelink: vi.fn(),
  inspectFolderRelink: vi.fn(),
  getRelinkInspection: vi.fn(),
  applyRelink: vi.fn(),
  inspectMissingRemoval: vi.fn(),
  removeMissing: vi.fn(),
  retryRefresh: vi.fn(),
}));
vi.mock("@/actions/library-reliability", () => ({
  libraryReliabilityActions: actions,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

it("preserves source status through a saved search and IPC filter conversion", () => {
  const filters = { libraryStatus: "missing", isoMin: "100" } as const;
  writeSearchPresets([{ name: "Missing files", createdAt: 1, filters }]);
  const saved = readSearchPresets();
  expect(saved[0].filters).toEqual(filters);
  expect(buildSearchFilterParams(saved[0].filters)).toEqual({
    libraryStatus: "missing",
    isoMin: 100,
  });
  localStorage.clear();
});

it("keeps healthy cards quiet and labels unavailable or stale content", () => {
  const { rerender } = render(
    <LibraryPhotoStatusBadge refreshStatus="ready" sourceStatus="available" />
  );
  expect(
    screen.queryByText("libraryReliability.status.available")
  ).not.toBeInTheDocument();
  rerender(
    <LibraryPhotoStatusBadge refreshStatus="ready" sourceStatus="offline" />
  );
  expect(screen.getByText("libraryReliability.status.offline")).toHaveAttribute(
    "tabindex",
    "0"
  );
  rerender(
    <LibraryPhotoStatusBadge refreshStatus="failed" sourceStatus="available" />
  );
  expect(screen.getByText("libraryReliability.status.failed")).toBeVisible();
});

it("requires explicit confirmation for weak evidence across all relink pages", async () => {
  actions.inspectPhotoRelink.mockResolvedValue({
    token: "preview",
    items: [
      {
        photoId: 1,
        oldPath: "old.jpg",
        newPath: "new.jpg",
        status: "unverified",
      },
    ],
    unverifiedPhotoIds: [1, 101],
    total: 101,
    canApply: true,
    counts: { unverified: 2 },
  });
  actions.getRelinkInspection.mockResolvedValue({
    token: "preview",
    items: [
      {
        photoId: 101,
        oldPath: "old-101.jpg",
        newPath: "new-101.jpg",
        status: "unverified",
      },
    ],
    unverifiedPhotoIds: [1, 101],
    total: 101,
    canApply: true,
    counts: { unverified: 2 },
  });
  actions.applyRelink.mockResolvedValue({ updated: 2 });
  render(<LibraryRelinkButton target={{ photoId: 1 }} />);
  fireEvent.click(
    screen.getByRole("button", { name: "libraryReliability.relink" })
  );
  const confirm = await screen.findByRole("button", { name: "confirm" });
  expect(confirm).toBeDisabled();
  fireEvent.click(
    screen.getByRole("button", { name: "libraryReliability.nextPage" })
  );
  await screen.findByText("new-101.jpg");
  expect(actions.getRelinkInspection).toHaveBeenCalledWith("preview", 100);
  const all = screen.getAllByRole("checkbox")[0];
  fireEvent.click(all);
  expect(confirm).toBeEnabled();
  fireEvent.click(confirm);
  await waitFor(() =>
    expect(actions.applyRelink).toHaveBeenCalledWith("preview", [1, 101])
  );
});

it("shows a missing-record impact before removing it from the catalogue", async () => {
  actions.inspectMissingRemoval.mockResolvedValue({
    token: "remove",
    photoIds: [7],
    links: { tags: 2, albums: 1, faces: 1, cull: 1 },
  });
  actions.removeMissing.mockResolvedValue({ removed: 1 });
  render(
    <LibraryPhotoControls
      photo={{ id: 7, sourceStatus: "missing", refreshStatus: "ready" }}
    />
  );
  fireEvent.click(
    screen.getByRole("button", { name: "libraryReliability.resolve" })
  );
  fireEvent.click(
    screen.getByRole("button", { name: "libraryReliability.remove" })
  );
  const confirm = await screen.findByRole("button", { name: "confirm" });
  expect(actions.removeMissing).not.toHaveBeenCalled();
  expect(screen.getByText(REMOVAL_LINKS)).toBeVisible();
  fireEvent.click(confirm);
  await waitFor(() =>
    expect(actions.removeMissing).toHaveBeenCalledWith("remove")
  );
});

it("loads library health only after opening and allows a check to be cancelled", async () => {
  actions.getHealth.mockResolvedValue({
    total: 2,
    unavailable: 1,
    pending: 0,
    failed: 0,
    folders: [],
    counts: {
      available: 1,
      offline: 1,
      missing: 0,
      inaccessible: 0,
      unverified: 0,
    },
  });
  actions.reconcile.mockResolvedValue({ taskId: "task" });
  actions.getTask.mockResolvedValue({
    taskId: "task",
    status: "running",
    total: 2,
    processed: 1,
    errors: [],
  });
  actions.cancelTask.mockResolvedValue({ status: "cancelled" });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <LibraryHealthDialog folderId={5} />
    </QueryClientProvider>
  );
  expect(actions.getHealth).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "libraryReliability.title" })
  );
  await screen.findByRole("button", { name: "libraryReliability.check" });
  expect(actions.getHealth).toHaveBeenCalledWith(5);
  fireEvent.click(
    screen.getByRole("button", { name: "libraryReliability.check" })
  );
  fireEvent.click(await screen.findByRole("button", { name: "cancel" }));
  await waitFor(() => expect(actions.cancelTask).toHaveBeenCalledWith("task"));
  client.clear();
});

it("hides healthy and ordinary pending detail notices and badges", () => {
  const { rerender } = render(
    <LibraryPhotoControls
      photo={{ id: 1, sourceStatus: "available", refreshStatus: "ready" }}
    />
  );
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  rerender(
    <LibraryPhotoControls
      photo={{ id: 1, sourceStatus: "unverified", refreshStatus: "pending" }}
    />
  );
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  rerender(
    <LibraryPhotoStatusBadge
      refreshStatus="pending"
      sourceStatus="unverified"
    />
  );
  expect(
    screen.queryByText("libraryReliability.status.pending")
  ).not.toBeInTheDocument();
});

it("keeps maintenance behind file actions and never offers missing removal for offline sources", () => {
  render(
    <LibraryPhotoControls
      photo={{ id: 1, sourceStatus: "offline", refreshStatus: "ready" }}
      variant="menu"
    />
  );
  expect(
    screen.queryByRole("button", { name: "libraryReliability.checkFile" })
  ).not.toBeInTheDocument();
  const fileActions = screen.getByRole("button", {
    name: "libraryReliability.fileActions",
  });
  expect(fileActions.textContent).toBe("");
  fireEvent.click(fileActions);
  expect(
    screen.getByRole("button", { name: "libraryReliability.checkFile" })
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "libraryReliability.remove" })
  ).not.toBeInTheDocument();
});

it("shows a single scoped attention entry and removes it after recovery", async () => {
  const healthy = {
    total: 1,
    unavailable: 0,
    pending: 1,
    failed: 0,
    attentionCount: 0,
    folders: [],
    counts: {
      available: 1,
      unverified: 0,
      offline: 0,
      missing: 0,
      inaccessible: 0,
    },
  };
  actions.getHealth.mockResolvedValue(healthy);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <LibraryHealthDialog attentionOnly folderId={5} />
    </QueryClientProvider>
  );
  await waitFor(() => expect(actions.getHealth).toHaveBeenCalledWith(5));
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  actions.getHealth.mockResolvedValue({
    ...healthy,
    attentionCount: 1,
    failed: 1,
  });
  await client.invalidateQueries({ queryKey: ["libraryHealth"] });
  const attention = await screen.findByRole("button", {
    name: "libraryReliability.attention",
  });
  expect(attention.textContent).toBe("");
  actions.getHealth.mockResolvedValue(healthy);
  await client.invalidateQueries({ queryKey: ["libraryHealth"] });
  await waitFor(() =>
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  );
  client.clear();
});

it("tracks a file check to completion and shows its actual missing result", async () => {
  actions.reconcile.mockResolvedValue({ taskId: "photo-check" });
  actions.getTask.mockResolvedValue({
    status: "done",
    errors: [],
    photoStatus: { sourceStatus: "missing" },
  });
  render(
    <LibraryPhotoControls
      photo={{ id: 7, sourceStatus: "missing", refreshStatus: "ready" }}
      variant="menu"
    />
  );
  fireEvent.click(
    screen.getByRole("button", { name: "libraryReliability.fileActions" })
  );
  fireEvent.click(
    screen.getByRole("button", { name: "libraryReliability.checkFile" })
  );
  await waitFor(() =>
    expect(actions.getTask).toHaveBeenCalledWith("photo-check")
  );
  await screen.findByText("libraryReliability.checkResult");
  expect(
    screen.getByRole("button", { name: "libraryReliability.checkFile" })
  ).toBeEnabled();
});

it("lists affected filenames and offers their recovery actions without searching the gallery", async () => {
  actions.getHealth.mockResolvedValue({
    attentionCount: 1,
    total: 1,
    unavailable: 1,
    failed: 0,
    pending: 0,
    counts: {},
    folders: [],
  });
  actions.getIssues.mockResolvedValue({
    total: 1,
    offset: 0,
    limit: 20,
    items: [
      {
        id: 7,
        filename: "missing-photo.jpg",
        path: "D:/source/missing-photo.jpg",
        sourceStatus: "missing",
        refreshStatus: "ready",
      },
    ],
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <LibraryHealthDialog />
    </QueryClientProvider>
  );
  fireEvent.click(
    screen.getByRole("button", { name: "libraryReliability.title" })
  );
  await screen.findByText("missing-photo.jpg");
  expect(screen.getByText("D:/source/missing-photo.jpg")).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "libraryReliability.managePhoto" })
  );
  expect(
    screen.getByRole("button", { name: "libraryReliability.relink" })
  ).toBeVisible();
  client.clear();
});

it.each([
  "failed",
  "cancelled",
] as const)("reports %s checks instead of silently finishing", async (status) => {
  actions.reconcile.mockResolvedValue({ taskId: "photo-check" });
  actions.getTask.mockResolvedValue({
    status,
    errors: status === "failed" ? ["EACCES"] : [],
    photoStatus: null,
  });
  render(
    <LibraryPhotoControls
      photo={{ id: 7, sourceStatus: "missing", refreshStatus: "ready" }}
      variant="menu"
    />
  );
  fireEvent.click(
    screen.getByRole("button", { name: "libraryReliability.fileActions" })
  );
  fireEvent.click(
    screen.getByRole("button", { name: "libraryReliability.checkFile" })
  );
  await screen.findByText(`libraryReliability.checkState.${status}`);
  expect(
    screen.getByRole("button", { name: "libraryReliability.checkFile" })
  ).toBeEnabled();
});

it("shows a check submission failure and allows retry", async () => {
  actions.reconcile.mockRejectedValueOnce(new Error("LIBRARY_TASK_BUSY"));
  render(
    <LibraryPhotoControls
      photo={{ id: 7, sourceStatus: "missing", refreshStatus: "ready" }}
      variant="menu"
    />
  );
  fireEvent.click(
    screen.getByRole("button", { name: "libraryReliability.fileActions" })
  );
  fireEvent.click(
    screen.getByRole("button", { name: "libraryReliability.checkFile" })
  );
  await screen.findByText("libraryReliability.checkState.failed");
  expect(
    screen.getByRole("button", { name: "libraryReliability.checkFile" })
  ).toBeEnabled();
});
