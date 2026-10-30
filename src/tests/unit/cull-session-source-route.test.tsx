import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CullSessionPage } from "@/routes/cull.$sessionId";

const LIBRARY_VIEW_PATTERN = /library-/;

const mocks = vi.hoisted(() => ({
  summary: vi.fn(),
  result: vi.fn(),
  navigate: vi.fn(),
  theme: vi.fn(),
}));
vi.mock("@/actions/cull", () => ({
  cullActions: { getSessionSummary: mocks.summary, getSession: mocks.result },
}));
vi.mock("@/actions/theme", () => ({ enterTemporaryDarkTheme: mocks.theme }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  createFileRoute: () => (config: object) => ({
    ...config,
    useParams: () => ({ sessionId: "41" }),
  }),
}));
vi.mock("@/components/RouteError", () => ({ RouteError: () => null }));
vi.mock("@/components/CullCurate", () => ({
  CullCurate: () => <div data-testid="library-curate" />,
}));
vi.mock("@/components/CullDuel", () => ({
  CullDuel: () => <div data-testid="library-duel" />,
}));
vi.mock("@/components/CullResult", () => ({
  CullResult: () => <div data-testid="library-results" />,
}));
const session = {
  id: 41,
  name: "Session",
  mode: "duel",
  status: "completed",
  keptCount: 2,
  rejectedCount: 0,
  pendingCount: 0,
  totalPhotos: 2,
  completedComparisons: 1,
};
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CullSessionPage />
    </QueryClientProvider>
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.result.mockResolvedValue({ ...session, items: [] });
  mocks.theme.mockReturnValue(vi.fn());
});
describe("cull session source routing", () => {
  it.each([
    "curate",
    "duel",
  ])("redirects a project %s session before any gallery view or full results load", async (mode) => {
    mocks.summary.mockResolvedValue({
      ...session,
      mode,
      projectId: "project-uuid",
    });
    mount();
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith({
        to: "/shooting-projects/$projectId",
        params: { projectId: "project-uuid" },
        replace: true,
      })
    );
    expect(mocks.result).not.toHaveBeenCalled();
    expect(mocks.theme).not.toHaveBeenCalled();
    expect(screen.queryAllByTestId(LIBRARY_VIEW_PATTERN)).toHaveLength(0);
  });
  it("continues to load completed gallery results for a library session", async () => {
    mocks.summary.mockResolvedValue({ ...session, projectId: null });
    mount();
    await screen.findByTestId("library-results");
    expect(mocks.result).toHaveBeenCalledWith({ sessionId: 41 });
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});
