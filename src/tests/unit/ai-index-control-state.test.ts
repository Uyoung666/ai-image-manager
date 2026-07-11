import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    isPackaged: false,
  },
}));

describe("AI index control state", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("exposes paused state through embedding progress", async () => {
    const state = await import("@/services/ai/state");
    const modelLoader = await import("@/services/ai/model-loader");

    state.beginEmbeddingRun();
    modelLoader.pauseEmbedding();
    state.finishEmbeddingRun(state.activeEmbeddingRunId, "paused");

    expect(modelLoader.getEmbeddingProgress()).toMatchObject({
      controlState: "paused",
      isActive: false,
      isPaused: true,
    });
  });

  it("rejects stale run completion after a newer run starts", async () => {
    const state = await import("@/services/ai/state");

    const oldRunId = state.beginEmbeddingRun();
    state.addWrittenPhotoIdsForRun(oldRunId, [1, 2]);
    const newRunId = state.beginEmbeddingRun();

    expect(state.finishEmbeddingRun(oldRunId, "idle")).toBe(false);
    expect(state.activeEmbeddingRunId).toBe(newRunId);
    expect([...state.getWrittenPhotoIdsForRun(oldRunId)]).toEqual([1, 2]);
    expect([...state.getWrittenPhotoIdsForRun(newRunId)]).toEqual([]);
  });

  it("keeps pending auto-tag ids across pause/resume runs", async () => {
    const state = await import("@/services/ai/state");

    const pausedRunId = state.beginEmbeddingRun();
    state.addPendingAutoTagPhotoIds([1, 2]);
    state.finishEmbeddingRun(pausedRunId, "paused");

    state.beginEmbeddingRun();
    state.addPendingAutoTagPhotoIds([3]);

    expect([...state.getPendingAutoTagPhotoIds()]).toEqual([1, 2, 3]);
    expect(state.drainPendingAutoTagPhotoIds()).toEqual([1, 2, 3]);
    expect([...state.getPendingAutoTagPhotoIds()]).toEqual([]);
  });

  it("removes cancelled photos from pending auto-tag ids", async () => {
    const state = await import("@/services/ai/state");

    state.beginEmbeddingRun();
    state.addPendingAutoTagPhotoIds([1, 2, 3]);
    state.removePendingAutoTagPhotoIds([2, 3]);

    expect([...state.getPendingAutoTagPhotoIds()]).toEqual([1]);
  });
});
