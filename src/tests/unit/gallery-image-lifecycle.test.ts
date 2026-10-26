import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chooseGalleryThumbnailEdge } from "@/utils/gallery-config";
import { isImageReady, scheduleImage } from "@/utils/image-scheduler";
import { PrioritySemaphore } from "@/utils/priority-semaphore";

class ImageFixture {
  static created: ImageFixture[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = "";
  constructor() {
    ImageFixture.created.push(this);
  }
}
beforeEach(() => {
  vi.useFakeTimers();
  ImageFixture.created = [];
  vi.stubGlobal("Image", ImageFixture);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("gallery request lifecycle", () => {
  it("waits until visible decoded images are displayed before preparing idle variants", async () => {
    const foreground = scheduleImage("visible-idle-barrier", {
      priority: 0,
      holdUntilDisplayed: true,
    });
    const warm = scheduleImage("idle-resource", {
      priority: 2,
      idleOnly: true,
      retainDecoded: false,
    });
    expect(ImageFixture.created).toHaveLength(1);
    ImageFixture.created[0].onload?.();
    await expect(foreground.promise).resolves.toBe("loaded");
    expect(ImageFixture.created).toHaveLength(1);
    foreground.release();
    expect(ImageFixture.created).toHaveLength(2);
    warm.release();
  });
  it("releases a React cleanup batch before starting any of its obsolete queued images", async () => {
    const handles = Array.from({ length: 30 }, (_, index) =>
      scheduleImage(`obsolete-${index}`, { priority: 0 })
    );
    expect(ImageFixture.created).toHaveLength(6);
    for (const handle of handles) {
      handle.release();
    }
    await Promise.all(handles.map((handle) => handle.promise));
    expect(ImageFixture.created).toHaveLength(6);
    const next = scheduleImage("next-visible", { priority: 0 });
    expect(ImageFixture.created).toHaveLength(7);
    next.release();
  });
  it("does not evict visible decoded transfers when warming an undisplayed variant", async () => {
    const warm = scheduleImage("warm-variant", {
      priority: 2,
      retainDecoded: false,
    });
    Object.assign(ImageFixture.created[0], {
      complete: true,
      naturalWidth: 256,
    });
    ImageFixture.created[0].onload?.();
    await expect(warm.promise).resolves.toBe("loaded");
    expect(isImageReady("warm-variant")).toBe(false);
  });
  it("chooses physical edges for aspect and fractional DPI changes", () => {
    expect(chooseGalleryThumbnailEdge(140, 105, 1, 0)).toBe(2048);
    expect(chooseGalleryThumbnailEdge(140, 105, 2, 0)).toBe(2048);
    expect(chooseGalleryThumbnailEdge(220, 350, 1)).toBe(512);
    expect(chooseGalleryThumbnailEdge(220, 350, 2)).toBe(1024);
    expect(chooseGalleryThumbnailEdge(220, 350, 1.25)).toBe(512);
    expect(chooseGalleryThumbnailEdge(900, 1200, 3)).toBe(2048);
    expect(chooseGalleryThumbnailEdge(140, 47, 1, 6)).toBe(512);
    expect(chooseGalleryThumbnailEdge(140, 233, 1, 0.2)).toBe(1024);
  });
  it("retries a visible timeout once and never retries background or cancelled work", async () => {
    const visible = scheduleImage("visible-timeout", { priority: 0 });
    await vi.advanceTimersByTimeAsync(8000);
    expect(ImageFixture.created).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(8000);
    await expect(visible.promise).resolves.toBe("failed");
    const background = scheduleImage("background-timeout");
    await vi.advanceTimersByTimeAsync(8000);
    await expect(background.promise).resolves.toBe("failed");
    expect(ImageFixture.created).toHaveLength(3);
  });
  it("keeps a native loading slot until the displayed image acknowledges it", async () => {
    const handles = Array.from({ length: 7 }, (_, index) =>
      scheduleImage(`display-${index}`, {
        priority: 0,
        holdUntilDisplayed: true,
      })
    );
    expect(ImageFixture.created).toHaveLength(6);
    ImageFixture.created[0].onload?.();
    await expect(handles[0].promise).resolves.toBe("loaded");
    expect(ImageFixture.created).toHaveLength(6);
    handles[0].release();
    expect(ImageFixture.created).toHaveLength(7);
    for (const handle of handles) {
      handle.release();
    }
  });
  it("removes aborted generation work and schedules foreground before maintenance", async () => {
    const slots = new PrioritySemaphore(1);
    await slots.acquire();
    const order: string[] = [];
    const controller = new AbortController();
    const cancelled = slots.acquire(controller.signal, 0);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    const background = slots.acquire(undefined, 2).then(() => {
      order.push("background");
      slots.release();
    });
    const visible = slots.acquire(undefined, 0).then(() => {
      order.push("visible");
      slots.release();
    });
    slots.release();
    await Promise.all([background, visible]);
    expect(order).toEqual(["visible", "background"]);
  });
});
