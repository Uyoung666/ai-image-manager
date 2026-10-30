import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CullListPage } from "@/routes/cull";
import type { CullTaskSummary } from "@/types/cull";

vi.mock("@/ipc/manager", () => ({ ipc: { client: {} } }));
vi.mock("@/components/ui/smooth-input", () => ({
  SmoothInput: ({
    wrapperClassName: _wrapper,
    ...props
  }: React.ComponentProps<"input"> & { wrapperClassName?: string }) => (
    <input {...props} />
  ),
}));

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
  inspectSource: vi.fn(),
  create: vi.fn(),
  navigate: vi.fn(),
  clearArchives: vi.fn(),
  translate: (key: string, options?: { count?: number }) =>
    key === "cullSessionCount" ? `Records:${options?.count}` : key,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.translate }),
}));
vi.mock("@/actions/cull", () => ({
  cullActions: {
    listTaskSummaries: mocks.list,
    clearArchivedTasks: mocks.clearArchives,
  },
}));
vi.mock("@/actions/shooting-projects", () => ({
  shootingProjectActions: {
    rename: mocks.rename,
    delete: mocks.remove,
    inspectSource: mocks.inspectSource,
    create: mocks.create,
  },
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
  useNavigate: () => mocks.navigate,
  useLocation: () => ({ state: { cullSettingsReturn: true } }),
}));
vi.mock("@/hooks/useRouteScrollRestoration", () => ({
  useRouteScrollRestoration: vi.fn(),
}));
vi.mock("@/components/filter-dropdown", () => ({
  FilterDropdown: ({
    options,
    onChange,
  }: {
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
  }) => (
    <div>
      {options.map((option) => (
        <button
          key={option.value}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  ),
}));

const active: CullTaskSummary = {
  kind: "project",
  id: "p",
  name: "Active shoot",
  sourceStatus: "online",
  workflow: "curate",
  createdAt: 3,
  archivedAt: null,
  photoCount: 4,
  keptCount: 2,
  stages: [],
};
const archived = {
  ...active,
  id: "archived",
  name: "Archived shoot",
  archivedAt: 4,
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mocks.list.mockImplementation(
    ({
      archived: isArchived,
      search,
    }: {
      archived: boolean;
      search: string;
    }) => {
      const rows: CullTaskSummary[] = isArchived
        ? [
            archived,
            {
              ...active,
              kind: "library",
              id: 3,
              name: "Archived library",
              archivedAt: 4,
            },
          ]
        : [
            active,
            { ...active, kind: "library", id: 1, name: "Library active" },
            { ...active, kind: "library", id: 2, name: "Library completed" },
          ];
      return rows.filter((row) =>
        row.name.toLowerCase().includes(search.trim().toLowerCase())
      );
    }
  );
});

describe("shared culling list filters", () => {
  it("uses the shared floating toolbar on scroll and keeps archive help out of the page body", async () => {
    render(<CullListPage archivedView />);
    await screen.findByText("Archived shoot");
    expect(
      screen.queryByText("cullProject.archive.description")
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "cullProject.archive.about" })
    ).toBeInTheDocument();
    const header = screen.getByTestId("cull-list-header");
    expect(header).toHaveClass("page-toolbar", "sticky");
    expect(header).not.toHaveClass("is-scrolled");
    fireEvent.scroll(screen.getByTestId("cull-list-scroll"), {
      target: { scrollTop: 40 },
    });
    expect(header).toHaveClass("is-scrolled");
    fireEvent.scroll(screen.getByTestId("cull-list-scroll"), {
      target: { scrollTop: 0 },
    });
    expect(header).not.toHaveClass("is-scrolled");
  });

  it("confirms and clears the whole archive independently of the current search", async () => {
    mocks.clearArchives.mockResolvedValue({
      deleted: 2,
      failed: 0,
      skipped: 0,
    });
    render(<CullListPage archivedView />);
    await screen.findByText("Archived shoot");
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "Archived shoot" },
    });
    await waitFor(() =>
      expect(screen.getAllByTestId("shooting-project-card")).toHaveLength(1)
    );
    fireEvent.click(screen.getByTestId("cull-clear-archives"));
    await screen.findByTestId("cull-clear-archives-dialog");
    expect(mocks.list).toHaveBeenLastCalledWith({ archived: true, search: "" });
    expect(mocks.clearArchives).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(mocks.clearArchives).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("cull-clear-archives"));
    await screen.findByTestId("cull-clear-archives-dialog");
    mocks.list.mockResolvedValue([]);
    fireEvent.click(screen.getByTestId("cull-clear-archives-confirm"));
    await waitFor(() =>
      expect(mocks.clearArchives).toHaveBeenCalledWith({
        confirmed: true,
        tasks: [
          { kind: "project", id: "archived", archivedAt: 4 },
          { kind: "library", id: 3, archivedAt: 4 },
        ],
      })
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
    expect(
      await screen.findByText("cullProject.noMatches")
    ).toBeInTheDocument();
  });

  it("keeps failed bulk deletion visible and retryable", async () => {
    mocks.clearArchives.mockRejectedValueOnce(new Error("Unavailable"));
    render(<CullListPage archivedView />);
    await screen.findByText("Archived shoot");
    fireEvent.click(screen.getByTestId("cull-clear-archives"));
    await screen.findByTestId("cull-clear-archives-confirm");
    fireEvent.click(screen.getByTestId("cull-clear-archives-confirm"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "cullProject.archive.clearFailed"
    );
    expect(screen.getByTestId("cull-clear-archives-confirm")).toBeEnabled();
    expect(screen.getByText("Archived shoot")).toBeInTheDocument();
  });

  it("keeps completed tasks in the active list and shows both sources in settings archives", async () => {
    const view = render(<CullListPage />);
    await screen.findByText("Active shoot");
    expect(screen.getByText("Library completed")).toBeInTheDocument();
    expect(screen.getByText("Records:3")).toBeInTheDocument();
    expect(
      screen.queryByText("shootingProject.archivedProjects")
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    view.rerender(<CullListPage archivedView />);
    await screen.findByText("Archived shoot");
    expect(screen.getByText("Records:2")).toBeInTheDocument();
    expect(screen.getByText("Archived library")).toBeInTheDocument();
    expect(screen.queryByTestId("cull-open-folder")).not.toBeInTheDocument();
    expect(mocks.list).toHaveBeenLastCalledWith({ archived: true, search: "" });
    expect(screen.queryByText("Library completed")).not.toBeInTheDocument();
    expect(screen.queryByText("Library active")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "no match" },
    });
    expect(
      await screen.findByText("cullProject.noMatches")
    ).toBeInTheDocument();
    expect(screen.queryByText("Archived shoot")).not.toBeInTheDocument();
  });
  it("ignores an old response that arrives after a newer search", async () => {
    render(<CullListPage />);
    await screen.findByText("Active shoot");
    let finishOld: (rows: (typeof active)[]) => void = () => undefined;
    mocks.list.mockImplementationOnce(
      () =>
        new Promise<CullTaskSummary[]>((resolve) => {
          finishOld = resolve;
        })
    );
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "old" },
    });
    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith({
        archived: false,
        search: "old",
      })
    );
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "no match" },
    });
    await screen.findByText("cullProject.noMatches");
    await act(async () => {
      finishOld([active]);
      await Promise.resolve();
    });
    expect(screen.queryByText("Active shoot")).not.toBeInTheDocument();
    expect(screen.getByText("cullProject.noMatches")).toBeInTheDocument();
  });
});

it("renames and deletes folder tasks through project actions", async () => {
  mocks.rename.mockResolvedValue({});
  mocks.remove.mockResolvedValue({});
  render(<CullListPage />);
  await screen.findByText("Active shoot");
  const card = screen.getByTestId("shooting-project-card");
  fireEvent.click(card.querySelectorAll("button")[2]);
  fireEvent.click(screen.getByRole("button", { name: "rename" }));
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "Renamed shoot" },
  });
  fireEvent.click(screen.getByRole("button", { name: "confirm" }));
  await waitFor(() =>
    expect(mocks.rename).toHaveBeenCalledWith({
      projectId: "p",
      name: "Renamed shoot",
    })
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  );
  fireEvent.click(card.querySelectorAll("button")[2]);
  fireEvent.click(screen.getByRole("button", { name: "delete" }));
  expect(
    screen.getByText("shootingProject.deleteDescription")
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "delete" }));
  await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith("p"));
  await waitFor(() =>
    expect(screen.queryByText("Active shoot")).not.toBeInTheDocument()
  );
});

it("retains a folder task and its confirmation when deleting fails", async () => {
  mocks.remove.mockRejectedValueOnce(new Error("Delete failed"));
  render(<CullListPage />);
  await screen.findByText("Active shoot");
  fireEvent.click(
    screen.getByTestId("shooting-project-card").querySelectorAll("button")[2]
  );
  fireEvent.click(screen.getByRole("button", { name: "delete" }));
  fireEvent.click(screen.getByRole("button", { name: "delete" }));
  await waitFor(() => expect(mocks.remove).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "delete" })).toBeEnabled()
  );
  expect(screen.getByText("Active shoot")).toBeInTheDocument();
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

it("restores the search when returning to its list and keeps archive search separate", async () => {
  const view = render(<CullListPage />);
  await screen.findByRole("searchbox");
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "Active shoot" },
  });
  await waitFor(() =>
    expect(screen.getAllByTestId("shooting-project-card")).toHaveLength(1)
  );
  view.unmount();
  const returned = render(<CullListPage />);
  expect(await screen.findByRole("searchbox")).toHaveValue("Active shoot");
  returned.unmount();
  render(<CullListPage archivedView />);
  expect(await screen.findByRole("searchbox")).toHaveValue("");
});

it("opens the direct-culling setup when a folder is dropped and preserves the archive entry context", async () => {
  const root = "D:\\素材\\本次拍摄";
  mocks.inspectSource.mockResolvedValue({
    sourceRoot: root,
    sourceStatus: "online",
    sourceInLibrary: false,
    defaultName: "本次拍摄",
  });
  Object.defineProperty(window, "electronAPI", {
    configurable: true,
    value: { getFilePath: () => root },
  });
  render(<CullListPage />);
  await screen.findByText("Active shoot");
  const dataTransfer = {
    types: ["Files"],
    items: [
      {
        kind: "file",
        getAsFile: () => new File([], "本次拍摄"),
        webkitGetAsEntry: () => ({ isDirectory: true }),
      },
    ],
  };
  fireEvent.dragEnter(screen.getByRole("region", { name: "cullTitle" }), {
    dataTransfer,
  });
  fireEvent.drop(
    screen.getByRole("button", { name: "cullProject.dropFolder" }),
    { dataTransfer }
  );
  await waitFor(() => expect(mocks.inspectSource).toHaveBeenCalledWith(root));
  expect(await screen.findByTestId("shooting-project-name")).toHaveValue(
    "本次拍摄"
  );
  expect(screen.getByTestId("shooting-workflow-curate")).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "cancel" }));
  fireEvent.click(screen.getByTestId("cull-archive-list-link"));
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/settings/cull-archive",
    state: { cullSettingsReturn: true },
  });
});

it("refreshes a running copy on the list and stops polling after completion", async () => {
  vi.useFakeTimers();
  mocks.list
    .mockResolvedValueOnce([{ ...active, outputStatus: "running" }])
    .mockResolvedValue([{ ...active, outputStatus: "completed" }]);
  const view = render(<CullListPage />);
  try {
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("cull-task-output-status")).toHaveTextContent(
      "shootingProject.outputStatus_running"
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(screen.getByTestId("cull-task-output-status")).toHaveTextContent(
      "shootingProject.outputStatus_completed"
    );
    const calls = mocks.list.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(mocks.list).toHaveBeenCalledTimes(calls);
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});
