import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DuplicatesPage } from "@/routes/duplicates";
import type { DuplicateGroupSummary } from "@/services/duplicate-groups";

const mocks = vi.hoisted(() => ({
  cleanDuplicateGroups: vi.fn(),
  dismissDuplicates: vi.fn(),
  getDuplicateGroupPhotos: vi.fn(),
  findDuplicates: vi.fn(),
}));
const PHOTO_FIVE_NAME = /5\.jpg/;
const PHOTO_TWO_NAME = /2\.jpg/;

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

vi.mock("@/components/PhotoLightbox", () => ({
  PhotoLightbox: ({
    initialIndex,
    onClose,
    photos,
    showThumbnailsInitially,
  }: {
    initialIndex: number;
    onClose: (result: { index: number; photoId: number }) => void;
    photos: Array<{ filename: string; id: number }>;
    showThumbnailsInitially?: boolean;
  }) => (
    <div aria-label="duplicatePreview" role="dialog">
      <span data-testid="preview-count">{photos.length}</span>
      <span data-testid="preview-index">{initialIndex}</span>
      <span data-testid="preview-photo">{photos[initialIndex]?.filename}</span>
      {showThumbnailsInitially ? (
        <span data-testid="preview-thumbnails" />
      ) : null}
      <button
        aria-label="close-preview"
        onClick={() =>
          onClose({
            index: initialIndex,
            photoId: photos[initialIndex]?.id ?? 0,
          })
        }
        type="button"
      />
    </div>
  ),
}));

function makeGroup(
  groupKey: string,
  matchType: "exact" | "similar",
  ids: number[]
): DuplicateGroupSummary {
  const photos = ids.map((id) => ({
    id,
    path: `C:\\photos\\${id}.jpg`,
    filename: `${id}.jpg`,
    fileSize: 1000,
    fileDate: 100,
    width: 100,
    height: 100,
    createdAt: 100,
    thumbnailPath: null,
  }));
  return {
    estimatedReclaimBytes: (ids.length - 1) * 1000,
    matchType,
    groupKey,
    pairCount: ids.length - 1,
    photoCount: ids.length,
    previewPhotos: photos,
    recommendedKeepId: ids[0],
    sequenceSummaries: [],
    status: "active",
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
    mocks.getDuplicateGroupPhotos.mockResolvedValue({
      hasMore: true,
      limit: 48,
      offset: 24,
      photos: [],
      total: 500,
    });
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
    expect(screen.getByRole("img", { name: "1.jpg" })).toHaveAttribute(
      "draggable",
      "false"
    );
    const user = userEvent.setup();
    await user.hover(screen.getByText("duplicateManualReview"));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "duplicateSimilarManualHint"
    );

    fireEvent.click(screen.getByText("duplicateConfirmGroup"));
    fireEvent.click(screen.getByRole("button", { name: PHOTO_FIVE_NAME }));
    fireEvent.click(screen.getByText("duplicateCleanupButton"));
    fireEvent.click(screen.getByText("duplicateConfirmCleanup"));

    await waitFor(() => {
      expect(mocks.cleanDuplicateGroups).toHaveBeenCalledWith({
        groups: [
          { groupKey: "exact:1-2-3", keepPhotoId: 1 },
          { groupKey: "similar:4-5", keepPhotoId: 5 },
        ],
      });
    });
  });

  it("opens the currently loaded photos in the large preview without selecting a keeper", async () => {
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
    const secondPhotoButton = screen.getByRole("button", {
      name: PHOTO_TWO_NAME,
    });
    expect(
      within(secondPhotoButton).getByText("pendingDelete")
    ).toBeInTheDocument();

    const previewButtons = screen.getAllByRole("button", {
      name: "duplicatePreviewPhoto",
    });
    expect(previewButtons[1]).toHaveClass(
      "opacity-0",
      "group-hover:opacity-100"
    );
    fireEvent.click(previewButtons[1]);

    expect(
      screen.getByRole("dialog", { name: "duplicatePreview" })
    ).toBeInTheDocument();
    expect(screen.getByTestId("preview-count")).toHaveTextContent("3");
    expect(screen.getByTestId("preview-index")).toHaveTextContent("1");
    expect(screen.getByTestId("preview-photo")).toHaveTextContent("2.jpg");
    expect(screen.getByTestId("preview-thumbnails")).toBeInTheDocument();
    expect(
      within(secondPhotoButton).getByText("pendingDelete")
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "close-preview" }));
    expect(
      screen.queryByRole("dialog", { name: "duplicatePreview" })
    ).not.toBeInTheDocument();
  });

  it("keeps a large group's preview bounded to the loaded page", async () => {
    const photos = Array.from({ length: 24 }, (_, index) => index + 100);
    const group = makeGroup("similar:100-123", "similar", photos);
    group.pairCount = 499;
    group.photoCount = 500;
    mocks.findDuplicates.mockResolvedValue({ groups: [group] });

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <DuplicatesPage />
      </QueryClientProvider>
    );

    await screen.findByText("100.jpg");
    fireEvent.click(
      screen.getAllByRole("button", { name: "duplicatePreviewPhoto" })[0]
    );

    expect(screen.getByTestId("preview-count")).toHaveTextContent("24");
    expect(screen.getByText("duplicatePhotoCount")).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.getDuplicateGroupPhotos).toHaveBeenCalledWith({
        groupKey: "similar:100-123",
        limit: 48,
        offset: 24,
      })
    );
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
