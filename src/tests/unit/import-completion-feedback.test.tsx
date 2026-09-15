import { act, render, waitFor } from "@testing-library/react";
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

beforeEach(() => vi.clearAllMocks());

it("summarizes a mixed import once, including existing photos on rescan", async () => {
  render(
    <GlobalAiStatusProvider>
      <div />
    </GlobalAiStatusProvider>
  );
  await act(async () => {
    await Promise.resolve();
  });
  const done = {
    id: 1,
    folderPath: "fixture",
    position: 1,
    status: "done",
    photoCount: 10,
    newPhotoCount: 10,
    skipped: 3,
    failed: 1,
  };
  const send = (history: unknown[]) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            channel: "import-queue-status",
            current: null,
            pending: [],
            history,
          },
        })
      );
    });
  send([done]);
  await waitFor(() => expect(mocks.warning).toHaveBeenCalledTimes(1));
  expect(mocks.warning.mock.calls[0][0]).toContain('"indexed":10');
  expect(mocks.warning.mock.calls[0][0]).toContain('"skipped":2');
  expect(mocks.warning.mock.calls[0][0]).toContain('"failed":1');
  send([done]);
  expect(mocks.warning).toHaveBeenCalledTimes(1);
  send([done, { ...done, id: 2, newPhotoCount: 0 }]);
  expect(mocks.warning.mock.calls[1][0]).toContain('"indexed":10');
  expect(mocks.error).not.toHaveBeenCalled();
});

it("keeps successful imports concise when no files are rejected", async () => {
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
      new MessageEvent("message", {
        data: {
          channel: "import-queue-status",
          current: null,
          pending: [],
          history: [
            {
              id: 3,
              status: "done",
              newPhotoCount: 10,
              photoCount: 10,
              skipped: 0,
            },
          ],
        },
      })
    )
  );
  expect(mocks.success).toHaveBeenCalledTimes(1);
  expect(mocks.warning).not.toHaveBeenCalled();
});
