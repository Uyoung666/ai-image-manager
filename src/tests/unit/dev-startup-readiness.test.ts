import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEV_RENDERER_FIRST_FRAME_MARK,
  scheduleDevRendererFirstFrame,
} from "@/utils/dev-startup-readiness";

afterEach(() => vi.unstubAllGlobals());
describe("development first-frame mark", () => {
  it("marks after two frames and preserves the original mark across HMR", () => {
    const frames: FrameRequestCallback[] = [];
    let marked = false;
    const mark = vi.fn(() => {
      marked = true;
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      frames.push(callback)
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("performance", {
      getEntriesByName: () => (marked ? [{}] : []),
      mark,
    });
    scheduleDevRendererFirstFrame();
    expect(mark).not.toHaveBeenCalled();
    frames.shift()?.(0);
    expect(mark).not.toHaveBeenCalled();
    frames.shift()?.(1);
    expect(mark).toHaveBeenCalledExactlyOnceWith(DEV_RENDERER_FIRST_FRAME_MARK);
    scheduleDevRendererFirstFrame();
    frames.shift()?.(2);
    frames.shift()?.(3);
    expect(mark).toHaveBeenCalledOnce();
  });
  it("cancels both pending animation frames when its root unmounts", () => {
    const frames: FrameRequestCallback[] = [];
    const cancel = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      frames.push(callback)
    );
    vi.stubGlobal("cancelAnimationFrame", cancel);
    const cleanup = scheduleDevRendererFirstFrame();
    frames[0](0);
    cleanup();
    expect(cancel).toHaveBeenCalledWith(1);
    expect(cancel).toHaveBeenCalledWith(2);
  });
});
