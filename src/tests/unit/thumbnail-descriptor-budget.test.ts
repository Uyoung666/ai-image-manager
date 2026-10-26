/** @vitest-environment node */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeGalleryThumbnails } from "@/services/thumbnail-identity";
import { releaseGalleryResources } from "@/utils/gallery-lifecycle";

const tick = async () => {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
};
afterEach(() => {
  releaseGalleryResources();
  vi.restoreAllMocks();
});
describe("host thumbnail descriptor budget", () => {
  it("shares path reads across callers and keeps all windows within four stat slots", async () => {
    const calls: Array<{ file: string; resolve: (value: fs.Stats) => void }> =
      [];
    let active = 0;
    let peak = 0;
    vi.spyOn(fs.promises, "stat").mockImplementation((file) => {
      active++;
      peak = Math.max(peak, active);
      return new Promise<fs.Stats>((resolve) =>
        calls.push({
          file: String(file),
          resolve: (stat) => {
            active--;
            resolve(stat);
          },
        })
      );
    });
    const photo = (id: number) => ({
      id,
      path: path.resolve(`descriptor-${id}.jpg`),
    });
    const stats = { size: 10, mtimeMs: 20, ctimeMs: 30 } as fs.Stats;
    const first = describeGalleryThumbnails(
      Array.from({ length: 8 }, (_, id) => photo(id + 1)),
      2
    );
    const shared = describeGalleryThumbnails([photo(1)], 0);
    await tick();
    expect(calls).toHaveLength(4);
    const foreground = describeGalleryThumbnails([photo(100)], 0);
    await tick();
    calls[0].resolve(stats);
    await tick();
    expect(calls[4].file).toBe(photo(100).path);
    let cursor = 1;
    while (cursor < calls.length) {
      calls[cursor++].resolve(stats);
      await tick();
    }
    const [records, duplicate] = await Promise.all([first, shared, foreground]);
    expect(peak).toBe(4);
    expect(calls.filter((call) => call.file === photo(1).path)).toHaveLength(1);
    expect(records[0].thumbnailVersion).toBe(duplicate[0].thumbnailVersion);
  });
  it("drops results from a retired database scope without resetting native slot accounting", async () => {
    const completions: Array<(stat: fs.Stats) => void> = [];
    vi.spyOn(fs.promises, "stat").mockImplementation(
      () => new Promise<fs.Stats>((resolve) => completions.push(resolve))
    );
    const work = describeGalleryThumbnails(
      [{ id: 1, path: "old-scope.jpg" }],
      0
    );
    await tick();
    releaseGalleryResources();
    completions[0]({ size: 10, mtimeMs: 20, ctimeMs: 30 } as fs.Stats);
    expect(await work).toEqual([{ id: 1, path: "old-scope.jpg" }]);
  });
});
