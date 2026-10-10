/** @vitest-environment node */
import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  embed: vi.fn(),
  rebuild: vi.fn(),
  resetFlags: vi.fn(),
  send: vi.fn(),
  autoTagging: false,
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send: fixture.send } }],
  },
}));
vi.mock("@/db", () => ({
  getDatabase: () => {
    throw new Error("A blocked operation must not access the photo database");
  },
}));
vi.mock("@/services/ai-embedder", async () => {
  const state = await import("@/services/ai/state");
  return {
    get activeEmbeddingRunId() {
      return state.activeEmbeddingRunId;
    },
    get aiControlState() {
      return state.aiControlState;
    },
    batchSuggestTags: vi.fn(),
    cancelEmbedding: vi.fn(),
    checkAiHealth: vi.fn(),
    cleanupPartialEmbedding: vi.fn(),
    embedAllPhotos: fixture.embed,
    finishEmbeddingRun: state.finishEmbeddingRun,
    getAiReadiness: vi.fn(),
    getEmbeddingProgress: vi.fn(),
    isAutoTaggingActive: () => fixture.autoTagging,
    pauseEmbedding: vi.fn(),
    rebuildVectorDB: fixture.rebuild,
    resetAllAiProcessedFlags: fixture.resetFlags,
    resumeEmbedding: vi.fn(),
    setAiControlState: state.setAiControlState,
    setCurrentProgress: state.setCurrentProgress,
    setWasAutoRepaired: state.setWasAutoRepaired,
    stopEmbedding: vi.fn(),
  };
});

import {
  batchGenerateTags,
  cancelAiIndexing,
  pauseAiIndexing,
  resetAiIndex,
  startAiIndexing,
  stopAiIndexing,
} from "@/ipc/photos/handlers/ai";
import {
  aiControlState,
  isAiIndexResetting,
  setAiControlState,
  setIsAiIndexResetting,
  setWasAutoRepaired,
  wasAutoRepaired,
} from "@/services/ai/state";

beforeEach(() => {
  vi.clearAllMocks();
  fixture.autoTagging = false;
  fixture.embed.mockReset().mockResolvedValue(0);
  fixture.rebuild.mockReset().mockResolvedValue({ success: true });
  fixture.resetFlags.mockReset().mockReturnValue(3);
  setAiControlState("idle");
  setIsAiIndexResetting(false);
  setWasAutoRepaired(false);
});

describe("AI index reset ownership", () => {
  it("blocks concurrent reset, start, tag and control requests until cleanup finishes", async () => {
    let release!: (result: { success: boolean }) => void;
    fixture.rebuild.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const pendingReset = call(resetAiIndex, {});
    await vi.waitFor(() => expect(fixture.rebuild).toHaveBeenCalledOnce());

    expect(isAiIndexResetting).toBe(true);
    expect(aiControlState).toBe("idle");
    expect(await call(resetAiIndex, {})).toMatchObject({
      busy: true,
      success: false,
    });
    expect(await call(startAiIndexing, {})).toMatchObject({
      busy: true,
      started: false,
    });
    expect(await call(batchGenerateTags, {})).toMatchObject({ busy: true });
    expect(await call(stopAiIndexing, {})).toEqual({
      busy: true,
      stopped: false,
    });
    expect(await call(pauseAiIndexing, {})).toEqual({
      busy: true,
      paused: false,
    });
    expect(await call(cancelAiIndexing, {})).toEqual({
      busy: true,
      cancelled: false,
    });
    expect(fixture.rebuild).toHaveBeenCalledOnce();
    expect(fixture.embed).not.toHaveBeenCalled();
    expect(fixture.resetFlags).not.toHaveBeenCalled();

    release({ success: true });
    expect(await pendingReset).toEqual({ success: true });
    expect(isAiIndexResetting).toBe(false);
    expect(fixture.resetFlags).toHaveBeenCalledOnce();
    expect(fixture.send).toHaveBeenCalledWith("ai-status-changed");
    expect(await call(startAiIndexing, {})).toEqual({ started: true });
    expect(fixture.embed).toHaveBeenCalledOnce();
  });

  it("releases reset ownership after a failed rebuild without clearing photo flags", async () => {
    fixture.rebuild.mockResolvedValueOnce({
      success: false,
      error: "ENOTEMPTY",
    });

    expect(await call(resetAiIndex, {})).toEqual({
      success: false,
      error: "ENOTEMPTY",
    });
    expect(isAiIndexResetting).toBe(false);
    expect(wasAutoRepaired).toBe(false);
    expect(fixture.resetFlags).not.toHaveBeenCalled();
    expect(fixture.send).toHaveBeenCalledWith("ai-status-changed");

    expect(await call(resetAiIndex, {})).toEqual({ success: true });
    expect(fixture.rebuild).toHaveBeenCalledTimes(2);
    expect(fixture.resetFlags).toHaveBeenCalledOnce();
  });

  it("releases reset ownership when rebuilding unexpectedly throws", async () => {
    fixture.rebuild.mockRejectedValueOnce(new Error("Store connection lost"));

    await expect(call(resetAiIndex, {})).rejects.toThrow(
      "Store connection lost"
    );
    expect(isAiIndexResetting).toBe(false);
    expect(fixture.resetFlags).not.toHaveBeenCalled();
    expect(fixture.send).toHaveBeenCalledWith("ai-status-changed");
    expect(await call(resetAiIndex, {})).toEqual({ success: true });
  });

  it("keeps an active embedding or auto-tagging task protected from reset", async () => {
    setAiControlState("running");
    expect(await call(resetAiIndex, {})).toEqual({
      busy: true,
      success: false,
    });
    setAiControlState("idle");
    fixture.autoTagging = true;
    expect(await call(resetAiIndex, {})).toEqual({
      busy: true,
      success: false,
    });
    expect(fixture.rebuild).not.toHaveBeenCalled();
    expect(isAiIndexResetting).toBe(false);
  });
});
