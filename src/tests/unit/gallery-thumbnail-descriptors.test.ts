import { beforeEach, describe, expect, it, vi } from "vitest";

const pending = vi.hoisted(
  () =>
    [] as Array<{
      ids: number[];
      priority: number;
      resolve: (
        items: Array<{ id: number; thumbnailVersion?: string }>
      ) => void;
      reject: (error: Error) => void;
    }>
);
vi.mock("@/actions/photo-listing", () => ({
  photoListingActions: {
    thumbnailVersions: vi.fn(
      (ids: number[], priority: number) =>
        new Promise((resolve, reject) =>
          pending.push({ ids, priority, resolve, reject })
        )
    ),
  },
}));
const flush = async () => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};
const finish = (index: number) =>
  pending[index].resolve(
    pending[index].ids.map((id) => ({ id, thumbnailVersion: `source-${id}` }))
  );
beforeEach(() => {
  vi.resetModules();
  pending.length = 0;
});
describe("bounded thumbnail descriptor consumers", () => {
  it("shares IDs and serves visible work before prefetch in eight-ID batches", async () => {
    const { requestThumbnailVersion: request } = await import(
      "@/utils/gallery-thumbnail-descriptors"
    );
    const background = request(1, { priority: 2 });
    const visible = request(1, { priority: 0 });
    background.release();
    const handles = Array.from({ length: 20 }, (_, i) =>
      request(i + 2, { priority: 0 })
    );
    await flush();
    expect(pending).toHaveLength(2);
    expect(pending[0].ids).toContain(1);
    expect(
      pending.every((batch) => batch.ids.length <= 8 && batch.priority === 0)
    ).toBe(true);
    finish(0);
    finish(1);
    await flush();
    finish(2);
    await flush();
    await expect(visible.promise).resolves.toBe("source-1");
    expect(
      pending.flatMap((batch) => batch.ids).filter((id) => id === 1)
    ).toHaveLength(1);
    for (const handle of handles) {
      handle.release();
    }
    visible.release();
  });
  it("counts cancelled in-flight IPC until it really completes", async () => {
    const { requestThumbnailVersion: request } = await import(
      "@/utils/gallery-thumbnail-descriptors"
    );
    const old = Array.from({ length: 16 }, (_, id) =>
      request(id + 1, { generation: "old" })
    );
    await flush();
    expect(pending).toHaveLength(2);
    for (const handle of old) {
      handle.release();
    }
    const next = Array.from({ length: 16 }, (_, id) =>
      request(id + 1, { generation: "new" })
    );
    await flush();
    expect(pending).toHaveLength(2);
    finish(0);
    await flush();
    expect(pending).toHaveLength(3);
    finish(1);
    await flush();
    expect(pending).toHaveLength(4);
    finish(2);
    finish(3);
    await flush();
    await expect(old[0].promise).resolves.toBeUndefined();
    await expect(next[0].promise).resolves.toBe("source-1");
    for (const handle of next) {
      handle.release();
    }
  });
  it("promotes queued consumers and limits real background batches to one", async () => {
    const { requestThumbnailVersion: request } = await import(
      "@/utils/gallery-thumbnail-descriptors"
    );
    const background = Array.from({ length: 16 }, (_, id) =>
      request(id + 1, { priority: 2 })
    );
    await flush();
    expect(pending).toHaveLength(1);
    background[8].promote(0);
    await flush();
    expect(pending).toHaveLength(2);
    expect(pending[1]).toMatchObject({ ids: [9], priority: 0 });
    finish(1);
    await flush();
    expect(pending).toHaveLength(2);
    finish(0);
    await flush();
    expect(pending).toHaveLength(3);
    finish(2);
    await flush();
    for (const handle of background) {
      handle.release();
    }
  });
  it("never sends fully released queued IDs and falls through to HTTP error handling", async () => {
    const { requestThumbnailVersion: request } = await import(
      "@/utils/gallery-thumbnail-descriptors"
    );
    const removed = request(99);
    removed.release();
    const failed = request(1);
    await flush();
    expect(pending[0].ids).toEqual([1]);
    pending[0].reject(new Error("metadata unavailable"));
    await flush();
    await expect(failed.promise).resolves.toBeUndefined();
    failed.release();
  });
});
