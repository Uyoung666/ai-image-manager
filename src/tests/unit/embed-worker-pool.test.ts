import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    isPackaged: false,
  },
}));

describe("embed worker pool config", () => {
  it("keeps CPU-only defaults conservative", async () => {
    const { resolveEmbedPoolConfig } = await import(
      "@/services/embed-worker-pool"
    );

    expect(resolveEmbedPoolConfig(4, false, {})).toEqual({
      batchSize: 20,
      intraOpNumThreads: 3,
      workers: 1,
    });
    expect(resolveEmbedPoolConfig(12, false, {})).toEqual({
      batchSize: 20,
      intraOpNumThreads: 4,
      workers: 2,
    });
  });

  it("clamps env overrides to safe bounds", async () => {
    const { resolveEmbedPoolConfig } = await import(
      "@/services/embed-worker-pool"
    );

    expect(
      resolveEmbedPoolConfig(8, false, {
        AI_EMBED_BATCH_SIZE: "500",
        AI_EMBED_THREADS: "99",
        AI_EMBED_WORKERS: "99",
      })
    ).toEqual({
      batchSize: 100,
      intraOpNumThreads: 2,
      workers: 3,
    });
  });
});
