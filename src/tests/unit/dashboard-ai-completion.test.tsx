import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { GlobalAiStatusProvider } from "@/hooks/use-global-ai-status";

const mocks = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: mocks }));
vi.mock("@/providers/QueryProvider", () => ({
  queryClient: { invalidateQueries: mocks.invalidate },
}));
vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      photos: {
        getAiProgress: async () => null,
        getImportQueueStatus: async () => ({
          current: null,
          pending: [],
          history: [],
        }),
      },
      faces: { getDetectionProgress: async () => null },
    },
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: unknown) => JSON.stringify({ key, values }),
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.invalidate.mockReset();
});

it.each([
  true,
  false,
])("refreshes a cached pending count after AI completion (dashboard visible: %s)", async (visible) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  const key = ["dashboard", "stats", undefined, undefined];
  const fetchStats = vi.fn().mockResolvedValue({ pending: 0 });
  client.setQueryData(key, { pending: 156 });
  mocks.invalidate.mockImplementation((filters) =>
    client.invalidateQueries(filters)
  );
  function DashboardStats() {
    const { data } = useQuery({ queryKey: key, queryFn: fetchStats });
    return (
      <span>{data?.pending ? `pending:${data.pending}` : "complete"}</span>
    );
  }
  const content = (show: boolean) => (
    <QueryClientProvider client={client}>
      <GlobalAiStatusProvider>
        {show ? <DashboardStats /> : null}
      </GlobalAiStatusProvider>
    </QueryClientProvider>
  );
  const view = render(content(visible));
  await act(async () => {
    await Promise.resolve();
  });
  expect(fetchStats).not.toHaveBeenCalled();
  act(() =>
    window.dispatchEvent(
      new MessageEvent("message", { data: { channel: "ai-embedding-done" } })
    )
  );
  if (!visible) {
    view.rerender(content(true));
  }
  await screen.findByText("complete");
  expect(screen.queryByText("pending:156")).not.toBeInTheDocument();
  expect(fetchStats).toHaveBeenCalledTimes(1);
  view.unmount();
  client.clear();
});

it("invalidates dashboard statistics when AI finishes, even without a dashboard mounted", async () => {
  render(
    <GlobalAiStatusProvider>
      <div />
    </GlobalAiStatusProvider>
  );
  await act(async () => {
    await Promise.resolve();
  });
  act(() =>
    window.dispatchEvent(
      new MessageEvent("message", { data: { channel: "ai-embedding-done" } })
    )
  );
  expect(mocks.invalidate).toHaveBeenCalledWith({
    queryKey: ["dashboard", "stats"],
  });
});
