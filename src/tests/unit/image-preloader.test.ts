import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preloadImagesWithConcurrency } from "@/utils/image-preloader";
import { releaseImageGeneration, scheduleImage } from "@/utils/image-scheduler";

class TestImage {
  static instances: TestImage[] = [];
  onerror: (() => void) | null = null;
  onload: (() => void) | null = null;
  src = "";
  constructor() {
    TestImage.instances.push(this);
  }
}
beforeEach(() => {
  TestImage.instances = [];
  vi.stubGlobal("Image", TestImage);
});
afterEach(() => vi.unstubAllGlobals());
const flush = async () => {
  for (let index = 0; index < 5; index++) {
    await Promise.resolve();
  }
};

describe("shared image scheduler", () => {
  it("removes a query generation in one batch without starting its queued tasks or cancelling shared new consumers", async () => {
    const blockers = Array.from({ length: 6 }, (_, index) =>
      scheduleImage(`block-${index}`, { priority: 0, generation: "block" })
    );
    const old = scheduleImage("old-only", { priority: 0, generation: "old" });
    const sharedOld = scheduleImage("cross-query", {
      priority: 0,
      generation: "old",
    });
    const sharedNew = scheduleImage("cross-query", {
      priority: 0,
      generation: "new",
    });
    releaseImageGeneration("old");
    await expect(old.promise).resolves.toBe("cancelled");
    await expect(sharedOld.promise).resolves.toBe("cancelled");
    expect(TestImage.instances).toHaveLength(6);
    for (const handle of blockers) {
      handle.release();
    }
    await flush();
    expect(TestImage.instances.some((image) => image.src === "old-only")).toBe(
      false
    );
    const shared = TestImage.instances.find(
      (image) => image.src === "cross-query"
    );
    expect(shared).toBeDefined();
    shared?.onload?.();
    await expect(sharedNew.promise).resolves.toBe("loaded");
  });
  it("deduplicates active resources but verifies them again on a later visit", async () => {
    const first = preloadImagesWithConcurrency(["a", "a", "b"], 2);
    const second = preloadImagesWithConcurrency(["a"], 1);
    expect(TestImage.instances).toHaveLength(2);
    for (const image of TestImage.instances) {
      image.onload?.();
    }
    await expect(first).resolves.toEqual({ loaded: 2, failed: 0 });
    await expect(second).resolves.toEqual({ loaded: 1, failed: 0 });
    const revisit = preloadImagesWithConcurrency(["a"], 1);
    expect(TestImage.instances).toHaveLength(3);
    TestImage.instances[2].onload?.();
    await expect(revisit).resolves.toEqual({ loaded: 1, failed: 0 });
  });
  it("caps all active loads at six and prefetch at two, then prioritizes visible work", async () => {
    const handles = Array.from({ length: 4 }, (_, index) =>
      scheduleImage(`prefetch-${index}`, { priority: 2 })
    );
    expect(TestImage.instances).toHaveLength(2);
    handles.push(
      ...Array.from({ length: 6 }, (_, index) =>
        scheduleImage(`visible-${index}`, { priority: 0 })
      )
    );
    expect(TestImage.instances).toHaveLength(6);
    TestImage.instances[0].onload?.();
    await flush();
    expect(TestImage.instances[6].src).toBe("visible-4");
    for (const handle of handles) {
      handle.release();
    }
    await expect(
      Promise.all(handles.map((handle) => handle.promise))
    ).resolves.toHaveLength(10);
  });
  it("cancels one consumer without cancelling another and never starts abandoned queued jobs", async () => {
    const first = scheduleImage("shared", { priority: 0 });
    const second = scheduleImage("shared", { priority: 0 });
    first.release();
    expect(TestImage.instances[0].src).toBe("shared");
    TestImage.instances[0].onload?.();
    await expect(first.promise).resolves.toBe("cancelled");
    await expect(second.promise).resolves.toBe("loaded");
    const active = [
      scheduleImage("background-1"),
      scheduleImage("background-2"),
    ];
    const abandoned = scheduleImage("abandoned");
    abandoned.release();
    for (const handle of active) {
      handle.release();
    }
    expect(TestImage.instances.some((image) => image.src === "abandoned")).toBe(
      false
    );
  });
  it("promotes a queued resource and does not retry permanent image errors", async () => {
    const tasks = [
      scheduleImage("low-1"),
      scheduleImage("low-2"),
      scheduleImage("low-3"),
    ];
    tasks[2].promote(0);
    expect(TestImage.instances).toHaveLength(3);
    TestImage.instances[2].onerror?.();
    await expect(tasks[2].promise).resolves.toBe("failed");
    expect(TestImage.instances).toHaveLength(3);
    for (const task of tasks) {
      task.release();
    }
  });
});
