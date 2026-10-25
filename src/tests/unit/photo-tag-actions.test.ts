import { beforeEach, expect, it, vi } from "vitest";
import { photoTagActions } from "@/actions/photo-tags";

const actions = vi.hoisted(() => ({
  getBatchTags: vi.fn(),
  updateBatchTags: vi.fn(),
  undoBatchTagChanges: vi.fn(),
}));
vi.mock("@/ipc/manager", () => ({ ipc: { client: { photos: actions } } }));
beforeEach(() => vi.clearAllMocks());
it("merges ownership summaries across bounded photo chunks", async () => {
  const ids = Array.from({ length: 1500 }, (_, index) => index + 1);
  actions.getBatchTags
    .mockResolvedValueOnce({ total: 999, counts: [{ id: 1, count: 400 }] })
    .mockResolvedValueOnce({
      total: 500,
      counts: [
        { id: 1, count: 200 },
        { id: 2, count: 10 },
      ],
    });
  const summary = await photoTagActions.summary(ids);
  expect(summary).toEqual({
    total: 1499,
    counts: new Map([
      [1, 600],
      [2, 10],
    ]),
  });
  expect(
    actions.getBatchTags.mock.calls.map(([input]) => input.ids.length)
  ).toEqual([1000, 500]);
});
it("reports chunk progress and keeps an undo receipt for partial successes", async () => {
  const ids = Array.from({ length: 1500 }, (_, index) => index + 1);
  const progress = vi.fn();
  actions.updateBatchTags
    .mockResolvedValueOnce({ changed: 12, processed: 499 })
    .mockRejectedValueOnce(new Error("database error"));
  const result = await photoTagActions.apply(ids, [1], [2], progress);
  expect(result).toMatchObject({ changed: 12, processed: 499, failed: 1000 });
  expect(progress).toHaveBeenCalledExactlyOnceWith(500);
  expect(actions.updateBatchTags.mock.calls[0][0].operationId).toBe(
    result.operationId
  );
  expect(actions.updateBatchTags.mock.calls[1][0].operationId).toBe(
    result.operationId
  );
});
it("bounds each request by photo/tag pairs rather than photo count", async () => {
  const ids = Array.from({ length: 105 }, (_, index) => index + 1);
  const tagIds = Array.from({ length: 50 }, (_, index) => index + 1);
  actions.updateBatchTags.mockImplementation(async (input) => ({
    changed: input.ids.length * input.addTagIds.length,
    processed: input.ids.length,
  }));
  const progress = vi.fn();
  const result = await photoTagActions.apply(ids, tagIds, [], progress);
  expect(result).toMatchObject({ changed: 5250, processed: 105, failed: 0 });
  expect(
    actions.updateBatchTags.mock.calls.map(([input]) => input.ids.length)
  ).toEqual([20, 20, 20, 20, 20, 5]);
  expect(progress).toHaveBeenLastCalledWith(105);
});
it("consumes all undo pages and preserves conflict counts", async () => {
  actions.undoBatchTagChanges
    .mockResolvedValueOnce({
      restored: 1000,
      skipped: 0,
      done: false,
      expired: false,
    })
    .mockResolvedValueOnce({
      restored: 3,
      skipped: 1,
      done: true,
      expired: false,
    });
  expect(await photoTagActions.undo("receipt")).toEqual({
    restored: 1003,
    skipped: 1,
    expired: false,
  });
  expect(actions.undoBatchTagChanges).toHaveBeenCalledTimes(2);
});
