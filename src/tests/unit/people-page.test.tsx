import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowseSessionProvider } from "@/contexts/BrowseSessionContext";
import { PeoplePage } from "@/routes/people";

const mocks = vi.hoisted(() => ({
  getScanScope: vi.fn(),
  listHiddenIdentities: vi.fn(),
  listIdentities: vi.fn(),
  listReviewQueue: vi.fn(),
}));

vi.mock("@/actions/faces", () => ({
  faceActions: mocks,
}));

vi.mock("@/hooks/useFolders", () => ({
  useFolders: () => ({ data: [] }),
}));

vi.mock("@/hooks/use-global-ai-status", () => ({
  useGlobalAiStatus: () => ({ phase: "idle" }),
}));

vi.mock("@/hooks/useRouteScrollRestoration", () => ({
  useRouteScrollRestoration: () => undefined,
}));

vi.mock("@/components/ConfirmDialog", () => ({
  ConfirmDialog: () => null,
}));

vi.mock("@/components/face-scan-scope-dialog", () => ({
  FaceScanScopeDialog: () => null,
}));

vi.mock("@tanstack/react-router", () => ({
  Outlet: () => null,
  createFileRoute: () => (options: unknown) => options,
  useNavigate: () => vi.fn(),
  useRouterState: () => false,
}));

class IntersectionObserverMock {
  disconnect() {
    // The page only needs this observer to exist in jsdom.
  }

  observe() {
    // The page only needs this observer to exist in jsdom.
  }
}

vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);

const PEOPLE_NAMED_LABEL = /peopleNamed/;
const identity = {
  coverBbox: null,
  coverPhotoHeight: null,
  coverPhotoPath: null,
  coverPhotoWidth: null,
  coverThumbnailPath: null,
  createdAt: 1,
  faceCount: 2,
  id: 1,
  name: "Alice",
  representativePhotoId: null,
};

function renderPeople(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <BrowseSessionProvider>
        <PeoplePage />
      </BrowseSessionProvider>
    </QueryClientProvider>
  );
}

describe("PeoplePage", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
    mocks.getScanScope.mockResolvedValue({
      configured: false,
      folderIds: [],
    });
    mocks.listHiddenIdentities.mockResolvedValue([]);
    mocks.listIdentities.mockResolvedValue([identity]);
    mocks.listReviewQueue.mockResolvedValue([]);
  });

  it("restores the people filter and query after unmounting and mounting again", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const first = renderPeople(client);

    const queryInput = await screen.findByRole("searchbox", {
      name: "peopleSearch",
    });
    fireEvent.click(screen.getByRole("button", { name: PEOPLE_NAMED_LABEL }));
    fireEvent.change(queryInput, { target: { value: "Ali" } });
    expect(queryInput).toHaveValue("Ali");

    first.unmount();

    renderPeople(client);

    const restoredQueryInput = await screen.findByRole("searchbox", {
      name: "peopleSearch",
    });
    expect(restoredQueryInput).toHaveValue("Ali");
    expect(
      screen.getByRole("button", { name: PEOPLE_NAMED_LABEL })
    ).toHaveAttribute("aria-pressed", "true");
  });
});
