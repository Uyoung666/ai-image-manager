import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { CullCurate } from "@/components/CullCurate";
import { TooltipProvider } from "@/components/ui/tooltip";

const mocks = vi.hoisted(() => ({
  pair: vi.fn(),
  save: vi.fn(),
  complete: vi.fn(),
  open: vi.fn(),
  prepare: vi.fn(),
}));
vi.mock("@/actions/cull", () => ({
  cullActions: {
    getNextPair: mocks.pair,
    updatePhotoStatus: mocks.save,
    completeSession: mocks.complete,
    getPhotoExif: () => Promise.resolve(null),
    getPhotoMedia: () => Promise.resolve(null),
  },
}));
vi.mock("@/actions/shooting-projects", () => ({
  shootingProjectActions: { open: mocks.open, prepare: mocks.prepare },
}));
vi.mock("@/components/ZoomableImage", () => ({
  ZoomableImage: () => <span>photo</span>,
}));
vi.mock("@/hooks/use-chrome-visibility", () => ({
  useChromeVisibility: () => ({
    visible: true,
    containerRef: { current: null },
  }),
}));

const session = {
  id: 1,
  mode: "curate",
  totalPhotos: 1,
  completedComparisons: 0,
  keptCount: 0,
  rejectedCount: 0,
  status: "active",
} as const;
const single = {
  done: false,
  stats: { total: 1, completed: 0, remaining: 1 },
  single: {
    sessionPhotoId: 10,
    photo: {
      id: 10,
      source: { kind: "project", projectId: "p", photoId: "a" },
      filename: "a.jpg",
      width: 100,
      height: 100,
      format: "jpg",
    },
  },
};
function mount(onCompleted = vi.fn()) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <TooltipProvider>
        <CullCurate
          onCompleted={onCompleted}
          onMutationSuccess={vi.fn()}
          session={session}
        />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.save.mockResolvedValue({});
  mocks.complete.mockResolvedValue({});
  mocks.open.mockResolvedValue({ id: "p", sourceStatus: "online" });
  mocks.prepare.mockResolvedValue({});
});

it("persists natural completion before handing off and does not duplicate it", async () => {
  let acknowledge!: () => void;
  mocks.pair.mockResolvedValueOnce(single).mockResolvedValue({
    done: true,
    stats: { total: 1, completed: 1, remaining: 0 },
  });
  mocks.complete.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      })
  );
  const done = vi.fn();
  mount(done);
  await screen.findByTestId("cull-curate-current");
  fireEvent.keyDown(document, { key: "ArrowRight" });
  await waitFor(() => expect(mocks.complete).toHaveBeenCalledOnce());
  expect(done).not.toHaveBeenCalled();
  await act(async () => acknowledge());
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(mocks.complete).toHaveBeenCalledOnce();
});

it("keeps completion failures retryable without handing off early", async () => {
  mocks.pair.mockResolvedValueOnce(single).mockResolvedValue({
    done: true,
    stats: { total: 1, completed: 1, remaining: 0 },
  });
  mocks.complete
    .mockRejectedValueOnce(new Error("database unavailable"))
    .mockResolvedValue({});
  const done = vi.fn();
  mount(done);
  await screen.findByTestId("cull-curate-current");
  fireEvent.keyDown(document, { key: "ArrowRight" });
  const retry = await screen.findByRole("button", { name: "retry" });
  expect(done).not.toHaveBeenCalled();
  fireEvent.click(retry);
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
});

it("shows an actionable terminal failure and retries preview preparation", async () => {
  mocks.pair.mockResolvedValue({
    done: false,
    preparing: true,
    waiting: false,
    availability: { projectId: "p", reason: "failed", unavailable: 1 },
    stats: { total: 1, completed: 0, remaining: 0 },
  });
  mount();
  await screen.findByTestId("cull-waiting-state");
  expect(mocks.complete).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "retry" }));
  await waitFor(() =>
    expect(mocks.prepare).toHaveBeenCalledWith({
      projectId: "p",
      retryPreviews: true,
      checkNew: true,
    })
  );
  await waitFor(() => expect(mocks.pair).toHaveBeenCalledTimes(2));
});
