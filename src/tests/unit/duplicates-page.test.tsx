import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DuplicatesPage } from "@/routes/duplicates";
import type { DuplicateGroup } from "@/services/duplicate-groups";

const mocks = vi.hoisted(() => ({
  cleanDuplicateGroups: vi.fn(),
  dismissDuplicates: vi.fn(),
  findDuplicates: vi.fn(),
}));
const PHOTO_FIVE_NAME = /5\.jpg/;

class ResizeObserverMock {
  disconnect() {
    // The page only needs this observer to exist in jsdom.
  }
  observe() {
    // The page only needs this observer to exist in jsdom.
  }
}

vi.stubGlobal("ResizeObserver", ResizeObserverMock);

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      photos: mocks,
    },
  },
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
  useNavigate: () => vi.fn(),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({
    count,
    getItemKey,
  }: {
    count: number;
    getItemKey: (index: number) => string;
  }) => ({
    getTotalSize: () => count * 500,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: getItemKey(index),
        start: index * 500,
      })),
    measureElement: vi.fn(),
  }),
}));

vi.mock("@/components/ConfirmDialog", () => ({
  ConfirmDialog: ({
    confirmText,
    onConfirm,
    open,
  }: {
    confirmText: string;
    onConfirm: () => void;
    open: boolean;
  }) =>
    open ? (
      <button onClick={onConfirm} type="button">
        {confirmText}
      </button>
    ) : null,
}));

function makeGroup(
  groupKey: string,
  matchType: "exact" | "similar",
  ids: number[]
): DuplicateGroup {
  return {
    groupKey,
    matchType,
    status: "active",
    pairIds: ids
      .slice(1)
      .map((_, index) => index + (matchType === "exact" ? 1 : 10)),
    recommendedKeepId: ids[0],
    estimatedReclaimBytes: (ids.length - 1) * 1000,
    photos: ids.map((id) => ({
      id,
      path: `C:\\photos\\${id}.jpg`,
      filename: `${id}.jpg`,
      fileSize: 1000,
      fileDate: 100,
      width: 100,
      height: 100,
      createdAt: 100,
      thumbnailPath: null,
    })),
  };
}

describe("DuplicatesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findDuplicates.mockResolvedValue({
      groups: [
        makeGroup("exact:1-2-3", "exact", [1, 2, 3]),
        makeGroup("similar:4-5", "similar", [4, 5]),
      ],
    });
    mocks.cleanDuplicateGroups.mockResolvedValue({ deleted: 3 });
  });

  it("preselects exact copies but requires confirmation for similar groups", async () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    render(
      <QueryClientProvider client={client}>
        <DuplicatesPage />
      </QueryClientProvider>
    );

    await screen.findByText("1.jpg");
    expect(screen.getByText("duplicateManualReview")).toHaveAttribute(
      "title",
      "duplicateSimilarManualHint"
    );

    fireEvent.click(screen.getByText("duplicateConfirmGroup"));
    fireEvent.click(screen.getByRole("button", { name: PHOTO_FIVE_NAME }));
    fireEvent.click(screen.getByText("duplicateCleanupButton"));
    fireEvent.click(screen.getByText("duplicateConfirmCleanup"));

    await waitFor(() => {
      expect(mocks.cleanDuplicateGroups).toHaveBeenCalledWith({
        groups: [
          {
            pairIds: [1, 2],
            keepPhotoId: 1,
            deletePhotoIds: [2, 3],
          },
          {
            pairIds: [10],
            keepPhotoId: 5,
            deletePhotoIds: [4],
          },
        ],
      });
    });
  });

  it("shows the shared back-to-top control after scrolling and returns the list to the top", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const scrollTo = vi.fn();
    render(
      <QueryClientProvider client={client}>
        <DuplicatesPage />
      </QueryClientProvider>
    );

    await screen.findByText("1.jpg");
    const scrollContainer = screen.getByText("1.jpg").closest("main");
    expect(scrollContainer).not.toBeNull();
    Object.defineProperties(scrollContainer as HTMLElement, {
      clientHeight: { configurable: true, value: 100 },
      scrollTo: { configurable: true, value: scrollTo },
      scrollTop: { configurable: true, value: 10 },
    });

    fireEvent.scroll(scrollContainer as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "backToTop" }));

    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });
});
