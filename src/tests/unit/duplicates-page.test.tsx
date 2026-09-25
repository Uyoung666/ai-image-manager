import assert from "node:assert/strict";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DuplicatesPage } from "@/routes/duplicates";
import type { DuplicateGroupSummary } from "@/services/duplicate-groups";

const mocks = vi.hoisted(() => ({
  cleanDuplicateGroups: vi.fn(),
  applyDuplicateKeepCount: vi.fn(),
  updateDuplicateReview: vi.fn(),
  createDuplicateCleanupPlan: vi.fn(),
  executeDuplicateCleanupPlan: vi.fn(),
  restoreDuplicateCleanupBatch: vi.fn(),
  listDuplicateCleanupBatches: vi.fn(),
  getDuplicateScanProgress: vi.fn(),
  cancelDuplicateScan: vi.fn(),
  dismissDuplicates: vi.fn(),
  getDuplicateGroupPhotos: vi.fn(),
  findDuplicates: vi.fn(),
}));
const IGNORED_FILTER = /duplicateIgnored/;

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
      settings: {
        getDuplicateSettings: vi
          .fn()
          .mockResolvedValue({ preset: "standard", revision: "0" }),
      },
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
    groupVersion: "v1",
    reviewRevision: 0,
    reviewDecisions: Object.fromEntries(
      ids.map((id) => [id, "UNDECIDED" as const])
    ),
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

let serverGroups: DuplicateGroupSummary[];
function setupGroups(groups: DuplicateGroupSummary[]) {
  serverGroups = groups;
  mocks.findDuplicates.mockImplementation(async () => ({
    groups: structuredClone(serverGroups),
  }));
}
function save(group: DuplicateGroupSummary) {
  group.reviewRevision = (group.reviewRevision ?? 0) + 1;
  const members = Object.entries(group.reviewDecisions ?? {}).map(
    ([id, decision]) => ({
      photoId: Number(id),
      decision,
      needsReview: decision === "UNDECIDED",
      contentRevision: 1,
    })
  );
  group.reviewNeedsReview = members.some((m) => m.needsReview);
  group.reviewComplete =
    !group.reviewNeedsReview && members.some((m) => m.decision === "KEEP");
  return {
    groupKey: group.groupKey,
    groupVersion: group.groupVersion,
    reviewRevision: group.reviewRevision,
    members,
    complete: group.reviewComplete,
    needsReview: group.reviewNeedsReview,
    ignoreState: "ACTIVE",
  };
}
function mount(
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
) {
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <DuplicatesPage />
      </QueryClientProvider>
    ),
  };
}
async function decide(id: number, decision: "Keep" | "Delete" | "Undecided") {
  const button = screen.getByRole("button", {
    name: `${id}.jpg duplicateDecision${decision}`,
  });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true"));
  await waitFor(() => expect(button).toBeEnabled());
}
function keepCount(value: string) {
  fireEvent.change(
    screen.getByRole("combobox", { name: "duplicateApplyKeepCount" }),
    { target: { value } }
  );
  fireEvent.click(screen.getByText("duplicateKeepCountConfirm"));
}

describe("DuplicatesPage persisted review", () => {
  it("allows unignore while keeping ignored review controls disabled", async () => {
    const group = makeGroup("exact:1-2-3", "exact", [1, 2, 3]);
    group.status = "dismissed";
    setupGroups([group]);
    mocks.dismissDuplicates.mockImplementation(({ dismissed }) => {
      group.status = dismissed ? "dismissed" : "active";
      return Promise.resolve({ dismissed: 1 });
    });
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: IGNORED_FILTER })
    );
    expect(
      await screen.findByRole("button", { name: "1.jpg duplicateDecisionKeep" })
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "duplicateUnignoreGroup" })
    );
    await waitFor(() =>
      expect(mocks.dismissDuplicates).toHaveBeenCalledWith({
        groupKey: group.groupKey,
        dismissed: false,
      })
    );
    expect(
      screen.queryByRole("combobox", { name: "duplicateSensitivity" })
    ).not.toBeInTheDocument();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    setupGroups([makeGroup("exact:1-2-3", "exact", [1, 2, 3])]);
    mocks.listDuplicateCleanupBatches.mockResolvedValue([]);
    mocks.getDuplicateScanProgress.mockResolvedValue({
      stage: "hashing",
      processed: 1,
      total: 3,
    });
    mocks.updateDuplicateReview.mockImplementation((input) => {
      const group = serverGroups.find((g) => g.groupKey === input.groupKey);
      assert(group?.reviewDecisions);
      const decisions = group.reviewDecisions;
      if (group.reviewRevision !== input.expectedReviewRevision) {
        throw new Error("STALE_REVIEW");
      }
      for (const item of input.decisions) {
        decisions[item.photoId] = item.decision;
      }
      return Promise.resolve(save(group));
    });
    mocks.applyDuplicateKeepCount.mockImplementation((input) => {
      const group = serverGroups.find((g) => g.groupKey === input.groupKey);
      assert(group?.reviewDecisions);
      const decisions = group.reviewDecisions;
      if (group.reviewRevision !== input.expectedReviewRevision) {
        throw new Error("STALE_REVIEW");
      }
      Object.keys(decisions).forEach((id, index) => {
        decisions[Number(id)] = index < input.count ? "KEEP" : "DELETE";
      });
      return Promise.resolve(save(group));
    });
    mocks.createDuplicateCleanupPlan.mockImplementation(async (input) => ({
      planId: "plan-1",
      groups: input.groups,
      deleteCount: input.groups.reduce(
        (n: number, g: { deletePhotoIds: number[] }) =>
          n + g.deletePhotoIds.length,
        0
      ),
      deleteBytes: 7000,
      expiresAt: Date.now() + 600_000,
    }));
    mocks.executeDuplicateCleanupPlan.mockResolvedValue({
      batchId: "batch-1",
      deletedCount: 2,
    });
    mocks.getDuplicateGroupPhotos.mockResolvedValue({
      photos: [],
      total: 500,
      hasMore: false,
    });
  });
  it("applies 10 keep 3 and creates the plan with the returned review revision", async () => {
    setupGroups([
      makeGroup(
        "exact:1-10",
        "exact",
        Array.from({ length: 10 }, (_, i) => i + 1)
      ),
    ]);
    mount();
    await screen.findByText("1.jpg");
    await keepCount("3");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "3.jpg duplicateDecisionKeep" })
      ).toHaveAttribute("aria-pressed", "true")
    );
    expect(
      screen.getByRole("button", { name: "4.jpg duplicateDecisionDelete" })
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByText("duplicateConfirmGroup"));
    await screen.findByText("duplicateRemoveFromCleanup");
    fireEvent.click(screen.getByText("duplicateCleanupButton"));
    await waitFor(() =>
      expect(mocks.createDuplicateCleanupPlan).toHaveBeenCalled()
    );
    expect(
      mocks.createDuplicateCleanupPlan.mock.calls[0][0].groups[0]
    ).toMatchObject({
      keepPhotoIds: [1, 2, 3],
      deletePhotoIds: [4, 5, 6, 7, 8, 9, 10],
      reviewRevision: 2,
    });
    fireEvent.click(await screen.findByText("duplicateConfirmCleanup"));
    await waitFor(() =>
      expect(mocks.executeDuplicateCleanupPlan).toHaveBeenCalledWith({
        planId: "plan-1",
      })
    );
  });
  it("persists partial decisions across unmount and refetch", async () => {
    const first = mount();
    await screen.findByText("1.jpg");
    await decide(2, "Delete");
    expect(screen.getByText("duplicateConfirmGroup")).toBeDisabled();
    first.unmount();
    mount();
    await screen.findByText("1.jpg");
    expect(
      screen.getByRole("button", { name: "2.jpg duplicateDecisionDelete" })
    ).toHaveAttribute("aria-pressed", "true");
  });
  it("removes cleanup authorization immediately after editing a confirmed group", async () => {
    mount();
    await screen.findByText("1.jpg");
    await keepCount("1");
    await waitFor(() =>
      expect(screen.getByText("duplicateConfirmGroup")).toBeEnabled()
    );
    fireEvent.click(screen.getByText("duplicateConfirmGroup"));
    await screen.findByText("duplicateRemoveFromCleanup");
    await decide(2, "Keep");
    expect(screen.getByText("duplicateCleanupButton")).toBeDisabled();
    fireEvent.click(screen.getByText("duplicateConfirmGroup"));
    await screen.findByText("duplicateRemoveFromCleanup");
    fireEvent.click(screen.getByText("duplicateCleanupButton"));
    await waitFor(() =>
      expect(mocks.createDuplicateCleanupPlan).toHaveBeenCalled()
    );
    expect(
      mocks.createDuplicateCleanupPlan.mock.calls[0][0].groups[0]
    ).toMatchObject({
      keepPhotoIds: [1, 2],
      deletePhotoIds: [3],
      reviewRevision: 4,
    });
  });
  it("keeps all photos without creating an empty deletion plan", async () => {
    mount();
    await screen.findByText("1.jpg");
    await keepCount("3");
    await waitFor(() =>
      expect(screen.getByText("duplicateConfirmGroup")).toBeEnabled()
    );
    fireEvent.click(screen.getByText("duplicateConfirmGroup"));
    await screen.findByText("duplicateRemoveFromCleanup");
    expect(screen.getByText("duplicateCleanupButton")).toBeDisabled();
    expect(mocks.createDuplicateCleanupPlan).not.toHaveBeenCalled();
  });
  it("does not display a failed save as a successful decision", async () => {
    mocks.updateDuplicateReview.mockRejectedValueOnce(new Error("offline"));
    mount();
    await screen.findByText("1.jpg");
    fireEvent.click(
      screen.getByRole("button", { name: "1.jpg duplicateDecisionKeep" })
    );
    await waitFor(() => expect(mocks.findDuplicates).toHaveBeenCalledTimes(2));
    expect(
      screen.getByRole("button", { name: "1.jpg duplicateDecisionUndecided" })
    ).toHaveAttribute("aria-pressed", "true");
  });
  it("keeps batch recovery and failure information available for retry", async () => {
    mocks.listDuplicateCleanupBatches.mockResolvedValue([
      { batchId: "batch-old", executedAt: 100, remainingCount: 2 },
    ]);
    mocks.restoreDuplicateCleanupBatch.mockResolvedValue({
      batchId: "batch-old",
      restoredIds: [2],
      failed: [
        { id: 3, filename: "c.jpg", message: "Original file no longer exists" },
      ],
      status: "RESTORE_PARTIAL",
    });
    mount();
    await screen.findByText("duplicateCleanupHistory");
    fireEvent.click(screen.getByText("duplicateCleanupHistory"));
    fireEvent.click(screen.getByText("duplicateCleanupRestoreButton"));
    await screen.findByText("duplicateCleanupRestoreFailureHint");
    expect(screen.getByText("c.jpg")).toBeVisible();
    expect(screen.getByRole("dialog")).toContainElement(
      screen.getByText("c.jpg")
    );
    expect(screen.getByText("duplicateCleanupRestoreButton")).toBeEnabled();
  });
  it("shows an initial scan failure with a retry action", async () => {
    mocks.findDuplicates.mockRejectedValueOnce(new Error("failed"));
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "duplicateScanFailed"
    );
    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    await screen.findByText("1.jpg");
  });
  it("opens a photo preview without changing any review decision", async () => {
    mount();
    await screen.findByText("1.jpg");
    fireEvent.click(
      screen.getByRole("button", { name: "2.jpg duplicatePreviewPhoto" })
    );
    expect(screen.getByTestId("preview-photo")).toHaveTextContent("2.jpg");
    expect(mocks.updateDuplicateReview).not.toHaveBeenCalled();
  });
  it("uses persisted decisions for members beyond the preview page", async () => {
    const group = makeGroup(
      "exact:large",
      "exact",
      Array.from({ length: 100 }, (_, i) => i + 1)
    );
    group.previewPhotos = group.previewPhotos.slice(0, 24);
    setupGroups([group]);
    mount();
    await screen.findByText("1.jpg");
    await keepCount("2");
    await waitFor(() =>
      expect(screen.getByText("duplicateConfirmGroup")).toBeEnabled()
    );
    fireEvent.click(screen.getByText("duplicateConfirmGroup"));
    await screen.findByText("duplicateRemoveFromCleanup");
    fireEvent.click(screen.getByText("duplicateCleanupButton"));
    await waitFor(() =>
      expect(mocks.createDuplicateCleanupPlan).toHaveBeenCalled()
    );
    expect(
      mocks.createDuplicateCleanupPlan.mock.calls[0][0].groups[0].deletePhotoIds
    ).toHaveLength(98);
  });
});
