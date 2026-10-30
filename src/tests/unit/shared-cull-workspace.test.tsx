import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShootingProjectWorkspace } from "@/components/ShootingProjectWorkspace";
import { rememberCullReturn } from "@/utils/cull-navigation";

const mocks = vi.hoisted(() => ({
  startProjectSession: vi.fn(),
  listProjectSessions: vi.fn(),
  getSessionSummary: vi.fn(),
  getSession: vi.fn(),
  getProjectResults: vi.fn(),
  projectWorkspace: vi.fn(),
  resumeSession: vi.fn(),
  refresh: vi.fn(),
  retry: vi.fn(),
  run: vi.fn(),
  accept: vi.fn(),
  navigate: vi.fn(),
  enterTheme: vi.fn(),
  restoreTheme: vi.fn(),
  pkMode: "standard" as "quick" | "standard" | "fine",
  workflow: "curate" as "curate" | "duel" | "hybrid",
  status: "active",
  comparisonsDone: false,
}));
vi.mock("@/actions/shooting-projects", () => ({
  shootingProjectActions: { workspace: mocks.projectWorkspace },
}));
vi.mock("@/actions/cull", () => ({ cullActions: mocks }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));
vi.mock("@/actions/theme", () => ({
  enterTemporaryDarkTheme: mocks.enterTheme,
}));
vi.mock("@/hooks/use-shooting-project-workspace", () => ({
  useShootingProjectWorkspace: () => ({
    data: {
      project: {
        id: "p",
        name: "Shared shoot",
        sourceStatus: "offline",
        workflow: mocks.workflow,
        pkMode: mocks.pkMode,
      },
      photos: [
        { id: "a", status: "kept" },
        { id: "b", status: "kept" },
      ],
      counts: { kept: 2 },
      previewBytes: 20,
      scan: { status: "completed", errors: [] },
    },
    refresh: mocks.refresh,
    retry: mocks.retry,
    run: mocks.run,
    accept: mocks.accept,
  }),
}));
vi.mock("@/components/CullCurate", () => ({
  CullCurate: ({
    session,
    completionActions,
    onCompleted,
  }: {
    session: { id: number };
    completionActions?: React.ReactNode;
    onCompleted?: () => void;
  }) => (
    <div data-testid="shared-curate">
      {session.id}
      {completionActions}
      <button onClick={onCompleted} type="button">
        Finish review
      </button>
    </div>
  ),
}));
vi.mock("@/components/CullDuel", () => ({
  CullDuel: ({
    session,
    onCompleted,
  }: {
    session: { id: number };
    onCompleted?: () => void;
  }) => (
    <div data-testid="shared-duel">
      {session.id}
      <button onClick={onCompleted} type="button">
        Finish PK
      </button>
    </div>
  ),
}));
vi.mock("@/components/CullResult", () => ({
  CullResult: ({
    project,
    session,
    initialStatusFilter,
    onRankingApplied,
  }: {
    session: { id: number };
    initialStatusFilter: string;
    onRankingApplied: () => void;
    project: {
      onStartPk: (ids: string[]) => void;
      onCopy: (ids?: string[]) => void;
    };
  }) => (
    <div data-testid="shared-results">
      {session.id}:{initialStatusFilter}
      <button onClick={onRankingApplied} type="button">
        Apply ranking
      </button>
      <button onClick={() => project.onStartPk(["a", "b"])} type="button">
        PK subset
      </button>
      <button onClick={() => project.onCopy(["a"])} type="button">
        Copy subset
      </button>
    </div>
  ),
}));
vi.mock("@/components/ShootingProjectManagement", () => ({
  ShootingProjectManagement: () => null,
}));
vi.mock("@/components/ShootingProjectOutputs", () => ({
  ShootingProjectOutputs: () => <div>outputs</div>,
  ShootingProjectOutputDialog: ({ photoIds }: { photoIds?: string[] }) => (
    <div data-testid="copy-dialog">{photoIds?.join(",") ?? "kept"}</div>
  ),
}));

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ShootingProjectWorkspace projectId="p" />
    </QueryClientProvider>
  );
}
beforeEach(() => {
  mocks.pkMode = "standard";
  sessionStorage.clear();
  vi.clearAllMocks();
  mocks.enterTheme.mockImplementation(() => mocks.restoreTheme);
  localStorage.clear();
  mocks.workflow = "curate";
  mocks.status = "active";
  mocks.startProjectSession.mockImplementation(({ mode }: { mode: string }) =>
    Promise.resolve({ id: mode === "curate" ? 1 : 3, mode, name: "round" })
  );
  mocks.listProjectSessions.mockResolvedValue([
    { id: 2, mode: "duel", name: "saved round" },
  ]);
  mocks.getSessionSummary.mockImplementation(
    ({ sessionId }: { sessionId: number }) =>
      Promise.resolve({
        id: sessionId,
        projectId: "p",
        mode: sessionId === 1 ? "curate" : "duel",
        status: sessionId === 1 ? "active" : mocks.status,
      })
  );
  mocks.getSession.mockImplementation(({ sessionId }: { sessionId: number }) =>
    Promise.resolve({
      id: sessionId,
      projectId: "p",
      mode: sessionId === 1 ? "curate" : "duel",
      items: [],
    })
  );
  mocks.resumeSession.mockResolvedValue({ success: true });
  mocks.projectWorkspace.mockResolvedValue({
    photos: [
      { id: "a", status: "kept" },
      { id: "b", status: "kept" },
      { id: "trash", status: "rejected" },
    ],
  });
  mocks.getProjectResults.mockImplementation(
    ({ rankingSessionId }: { rankingSessionId?: number }) =>
      Promise.resolve({
        id: 1,
        projectId: "p",
        mode: rankingSessionId ? "duel" : "curate",
        rankingSessionId: rankingSessionId ?? null,
        items: [],
      })
  );
});
describe("project shell reuses existing culling", () => {
  it("opens shared curate and recovers an existing PK round without creating another", async () => {
    mount();
    expect(await screen.findByTestId("shared-curate")).toHaveTextContent("1");
    fireEvent.click(screen.getByTestId("shooting-tab-duel"));
    expect(await screen.findByTestId("shared-duel")).toHaveTextContent("2");
    expect(mocks.startProjectSession).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("shooting-tab-curate"));
    await waitFor(() =>
      expect(mocks.resumeSession).toHaveBeenCalledWith({ sessionId: 1 })
    );
  });
  it("keeps every project view readable and restores the user's theme only on exit", async () => {
    const mounted = mount();
    await screen.findByTestId("shared-curate");
    expect(mocks.enterTheme).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("shooting-tab-duel"));
    await screen.findByTestId("shared-duel");
    fireEvent.click(screen.getByTestId("shooting-tab-result"));
    await screen.findByTestId("shared-results");
    expect(mocks.enterTheme).toHaveBeenCalledTimes(1);
    expect(mocks.restoreTheme).not.toHaveBeenCalled();
    mounted.unmount();
    expect(mocks.restoreTheme).toHaveBeenCalledTimes(1);
  });
  it("starts PK from the exact selected project photos through shared results", async () => {
    mount();
    await screen.findByTestId("shared-curate");
    fireEvent.click(screen.getByTestId("shooting-tab-result"));
    fireEvent.click(await screen.findByText("PK subset"));
    fireEvent.click(screen.getByTestId("shooting-pk-start"));
    await waitFor(() =>
      expect(mocks.startProjectSession).toHaveBeenCalledWith({
        projectId: "p",
        mode: "duel",
        scope: { kind: "selected", photoIds: ["a", "b"] },
        pkMode: "standard",
      })
    );
    expect(await screen.findByTestId("shared-duel")).toHaveTextContent("3");
  });
  it("uses ordinary original-copy dialogs for kept and explicit subsets", async () => {
    const screenView = mount();
    await screen.findByTestId("shared-curate");
    fireEvent.click(screen.getByTestId("shooting-copy-kept"));
    expect(screen.getByTestId("copy-dialog")).toHaveTextContent("kept");
    screenView.unmount();
    localStorage.clear();
    mount();
    await screen.findByTestId("shared-curate");
    fireEvent.click(screen.getByTestId("shooting-tab-result"));
    fireEvent.click(await screen.findByText("Copy subset"));
    expect(screen.getByTestId("copy-dialog")).toHaveTextContent("a");
  });
  it("shows completed PK actions without resuming or creating a round", async () => {
    mocks.status = "completed";
    mount();
    await screen.findByTestId("shared-curate");
    fireEvent.click(screen.getByTestId("shooting-tab-duel"));
    expect(
      await screen.findByText("cullProject.roundComplete")
    ).toBeInTheDocument();
    expect(screen.queryByTestId("shared-duel")).not.toBeInTheDocument();
    expect(mocks.resumeSession).not.toHaveBeenCalled();
    expect(mocks.startProjectSession).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("shooting-pk-results"));
    expect(await screen.findByTestId("shared-results")).toHaveTextContent(
      "2:all"
    );
    fireEvent.click(screen.getByText("Apply ranking"));
    expect(await screen.findByTestId("shared-results")).toHaveTextContent(
      "1:kept"
    );
  });
  it("opens the unified ranking on PK completion and can return to an unfinished round", async () => {
    mount();
    await screen.findByTestId("shared-curate");
    fireEvent.click(screen.getByTestId("shooting-tab-duel"));
    await screen.findByTestId("shared-duel");
    fireEvent.click(screen.getByTestId("shooting-pk-results"));
    expect(await screen.findByTestId("shared-results")).toHaveTextContent(
      "2:all"
    );
    fireEvent.click(screen.getByTestId("shooting-tab-duel"));
    expect(await screen.findByTestId("shared-duel")).toHaveTextContent("2");
    expect(mocks.startProjectSession).toHaveBeenCalledTimes(1);
  });
  it("moves a finished round to the single results view without a resume loop", async () => {
    mount();
    await screen.findByTestId("shared-curate");
    fireEvent.click(screen.getByTestId("shooting-tab-duel"));
    fireEvent.click(await screen.findByText("Finish PK"));
    expect(await screen.findByTestId("shared-results")).toHaveTextContent(
      "2:all"
    );
    fireEvent.click(screen.getByTestId("shooting-tab-duel"));
    expect(
      await screen.findByText("cullProject.roundComplete")
    ).toBeInTheDocument();
    expect(mocks.resumeSession).not.toHaveBeenCalled();
  });
  it("restores the round ranking context after leaving and reopening the project", async () => {
    const mounted = mount();
    await screen.findByTestId("shared-curate");
    fireEvent.click(screen.getByTestId("shooting-tab-duel"));
    await screen.findByTestId("shared-duel");
    fireEvent.click(screen.getByTestId("shooting-pk-results"));
    expect(await screen.findByTestId("shared-results")).toHaveTextContent(
      "2:all"
    );
    mounted.unmount();
    mount();
    expect(await screen.findByTestId("shared-results")).toHaveTextContent(
      "2:all"
    );
    fireEvent.click(screen.getByText("Apply ranking"));
    expect(await screen.findByTestId("shared-results")).toHaveTextContent(
      "1:kept"
    );
  });
  it("initializes direct comparison once and restores it on reopen", async () => {
    mocks.workflow = "duel";
    mocks.listProjectSessions.mockResolvedValueOnce([]);
    const mounted = mount();
    expect(await screen.findByTestId("shared-duel")).toHaveTextContent("3");
    expect(mocks.startProjectSession).toHaveBeenCalledWith({
      projectId: "p",
      mode: "duel",
      reuseExisting: true,
    });
    mounted.unmount();
    const calls = mocks.startProjectSession.mock.calls.length;
    mount();
    await screen.findByTestId("shared-duel");
    expect(mocks.startProjectSession).toHaveBeenCalledTimes(calls + 1);
  });
  it("passes only kept candidates from the hybrid completion action", async () => {
    mocks.workflow = "hybrid";
    mount();
    await screen.findByTestId("shared-curate");
    fireEvent.click(screen.getByTestId("shooting-pk-kept"));
    fireEvent.click(screen.getByTestId("shooting-pk-start"));
    await waitFor(() =>
      expect(mocks.startProjectSession).toHaveBeenCalledWith({
        projectId: "p",
        mode: "duel",
        scope: { kind: "selected", photoIds: ["a", "b"] },
        pkMode: "standard",
      })
    );
  });
  it("uses the current PK ranking for the final result, including after Top N", async () => {
    mocks.workflow = "hybrid";
    mount();
    await screen.findByTestId("shared-curate");
    fireEvent.click(screen.getByTestId("shooting-tab-result"));
    await screen.findByTestId("shared-results");
    expect(mocks.getProjectResults).toHaveBeenCalledWith({
      projectId: "p",
      rankingSessionId: 2,
    });
    fireEvent.click(screen.getByTestId("shooting-tab-duel"));
    await screen.findByTestId("shared-duel");
    fireEvent.click(screen.getByTestId("shooting-pk-results"));
    fireEvent.click(await screen.findByText("Apply ranking"));
    expect(await screen.findByTestId("shared-results")).toHaveTextContent(
      "1:kept"
    );
    expect(mocks.getProjectResults).toHaveBeenLastCalledWith({
      projectId: "p",
      rankingSessionId: 2,
    });
  });
  it("finishes partial review into PK using the saved keepers and excludes rejects", async () => {
    mocks.workflow = "hybrid";
    mount();
    await screen.findByTestId("shared-curate");
    fireEvent.click(screen.getByText("Finish review"));
    await screen.findByTestId("shared-duel");
    await waitFor(() =>
      expect(mocks.startProjectSession).toHaveBeenCalledWith({
        projectId: "p",
        mode: "duel",
        scope: { kind: "selected", photoIds: ["a", "b"] },
        pkMode: "standard",
      })
    );
  });
});

it("returns a task opened from archives to the archived list", async () => {
  rememberCullReturn("project", "p", true, true);
  mount();
  await screen.findByTestId("shared-curate");
  fireEvent.click(screen.getByTestId("shooting-project-back"));
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/settings/cull-archive",
    state: { cullSettingsReturn: true },
  });
});

it("uses the saved project PK strength when hybrid review ends", async () => {
  mocks.workflow = "hybrid";
  mocks.pkMode = "quick";
  mount();
  await screen.findByTestId("shared-curate");
  fireEvent.click(screen.getByText("Finish review"));
  await waitFor(() =>
    expect(mocks.startProjectSession).toHaveBeenCalledWith({
      projectId: "p",
      mode: "duel",
      scope: { kind: "selected", photoIds: ["a", "b"] },
      pkMode: "quick",
    })
  );
});
