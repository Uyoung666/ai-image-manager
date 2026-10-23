import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findMissingPhotoIds } from "@/services/orphan-photo-check";

afterEach(() => vi.restoreAllMocks());

describe("background orphan file probes", () => {
  it("limits filesystem work to two asynchronous probes", async () => {
    let active = 0;
    let peak = 0;
    const completions: Array<() => void> = [];
    vi.spyOn(fs.promises, "access").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          active++;
          peak = Math.max(peak, active);
          completions.push(() => {
            active--;
            resolve();
          });
        })
    );
    const items = Array.from({ length: 10 }, (_, id) => ({
      id,
      path: `${id}`,
    }));
    let done = false;
    const task = findMissingPhotoIds(items).then((result) => {
      done = true;
      return result;
    });
    expect(active).toBe(2);
    while (!done) {
      for (const complete of completions.splice(0)) {
        complete();
      }
      await Promise.resolve();
    }
    expect(await task).toEqual(new Set());
    expect(peak).toBe(2);
  });

  it("keeps permission and device failures out of missing-file results", async () => {
    vi.spyOn(fs.promises, "access").mockImplementation((file) =>
      Promise.reject(
        Object.assign(new Error("probe failed"), { code: String(file) })
      )
    );
    expect(
      await findMissingPhotoIds([
        { id: 1, path: "ENOENT" },
        { id: 2, path: "ENOTDIR" },
        { id: 3, path: "EACCES" },
        { id: 4, path: "EIO" },
      ])
    ).toEqual(new Set([1, 2]));
  });

  it("starts no further probes after cancellation", async () => {
    const controller = new AbortController();
    const access = vi.spyOn(fs.promises, "access").mockImplementation(() => {
      controller.abort();
      return Promise.resolve();
    });
    await findMissingPhotoIds(
      Array.from({ length: 20 }, (_, id) => ({ id, path: String(id) })),
      controller.signal
    );
    expect(access).toHaveBeenCalledTimes(1);
  });
});
