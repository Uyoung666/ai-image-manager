import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());
describe("shared gallery image observation", () => {
  it("uses one resize observer, one intersection observer per root, and batches sizes once per frame", async () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    const intersectionCallbacks: IntersectionObserverCallback[] = [];
    const frames: FrameRequestCallback[] = [];
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: ResizeObserverCallback) {
          resizeCallbacks.push(cb);
        }
        observe() {
          /* Native registration is represented by the callback. */
        }
        unobserve() {
          /* Native registration is represented by the callback. */
        }
        disconnect = disconnect;
      }
    );
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: IntersectionObserverCallback) {
          intersectionCallbacks.push(cb);
        }
        observe() {
          /* Native registration is represented by the callback. */
        }
        unobserve() {
          /* Native registration is represented by the callback. */
        }
        disconnect = disconnect;
      }
    );
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const { observeGalleryImage: observe } = await import(
      "@/utils/gallery-image-observer"
    );
    const root = document.createElement("div");
    root.dataset.masonryScroll = "";
    const first = document.createElement("div");
    const second = document.createElement("div");
    root.append(first, second);
    const size = vi.fn();
    const visible = vi.fn();
    const releaseA = observe(first, size, visible);
    const releaseB = observe(second, size, visible);
    expect(resizeCallbacks).toHaveLength(1);
    expect(intersectionCallbacks).toHaveLength(1);
    size.mockClear();
    resizeCallbacks[0](
      [
        { target: first, contentRect: { width: 140, height: 210 } },
        { target: second, contentRect: { width: 220, height: 330 } },
      ] as unknown as ResizeObserverEntry[],
      {} as ResizeObserver
    );
    expect(frames).toHaveLength(1);
    expect(size).not.toHaveBeenCalled();
    frames[0](0);
    expect(size.mock.calls).toEqual([
      [140, 210],
      [220, 330],
    ]);
    releaseA();
    expect(disconnect).not.toHaveBeenCalled();
    releaseB();
    expect(disconnect).toHaveBeenCalledTimes(2);
  });
  it("shares and tears down the window DPI listener", async () => {
    const events: EventTarget[] = [];
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => {
        const target = new EventTarget();
        events.push(target);
        return target;
      })
    );
    const { subscribeGalleryDpr: subscribe } = await import(
      "@/utils/gallery-image-observer"
    );
    const first = vi.fn();
    const second = vi.fn();
    const releaseA = subscribe(first);
    const releaseB = subscribe(second);
    expect(events).toHaveLength(1);
    events[0].dispatchEvent(new Event("change"));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(2);
    releaseA();
    releaseB();
    events[1].dispatchEvent(new Event("change"));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
