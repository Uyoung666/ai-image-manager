import { beforeEach, expect, it, vi } from "vitest";
import { photoOperationActions } from "@/actions/photo-operations";

const actions = vi.hoisted(() => ({
  deletePhotos: vi.fn(),
  restorePhotos: vi.fn(),
}));
vi.mock("@/ipc/manager", () => ({ ipc: { client: { photos: actions } } }));
beforeEach(() => vi.clearAllMocks());
it("shares the receipt across chunks and retains confirmed successes on partial failure", async () => {
  const ids = Array.from({ length: 1500 }, (_, index) => index + 1);
  actions.deletePhotos
    .mockImplementationOnce(({ ids, operationId }) =>
      Promise.resolve({
        deleted: 999,
        succeededIds: ids.slice(0, -1),
        deletionBatchId: operationId,
      })
    )
    .mockRejectedValueOnce(new Error("IPC failure"));
  const result = await photoOperationActions.deletePhotos({ ids });
  expect(result.deleted).toBe(999);
  expect(result.failedIds).toHaveLength(500);
  expect(actions.deletePhotos.mock.calls[0][0].operationId).toBe(
    actions.deletePhotos.mock.calls[1][0].operationId
  );
  expect(result.succeededIds).not.toContain(1000);
});
it("restores only receipt IDs with the expected deletion operation", async () => {
  actions.restorePhotos.mockResolvedValueOnce({
    succeededIds: [1],
    failed: [{ id: 2 }],
  });
  expect(await photoOperationActions.restoreDeleted([1, 2], "receipt")).toEqual(
    { succeededIds: [1], failed: 1 }
  );
  expect(actions.restorePhotos).toHaveBeenCalledWith({
    ids: [1, 2],
    expectedDeletionBatchId: "receipt",
  });
});
