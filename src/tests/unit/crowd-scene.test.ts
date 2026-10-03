import { gsap } from "gsap";
import { afterEach, expect, it, vi } from "vitest";
import { createCrowdScene } from "@/components/about/crowd-scene";

function canvasFixture() {
  const canvas = document.createElement("canvas");
  Object.defineProperties(canvas, {
    clientWidth: { configurable: true, value: 600 },
    clientHeight: { configurable: true, value: 220 },
  });
  const context = {
    clearRect: vi.fn(),
    save: vi.fn(),
    scale: vi.fn(),
    translate: vi.fn(),
    drawImage: vi.fn(),
    restore: vi.fn(),
  };
  vi.spyOn(canvas, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D
  );
  const image = new Image();
  Object.defineProperties(image, {
    naturalWidth: { value: 3600 },
    naturalHeight: { value: 2268 },
  });
  return { canvas, context, image };
}

afterEach(() => {
  gsap.ticker.sleep();
  vi.restoreAllMocks();
});

it("uses valid 15 by 7 sprite cells, caps pixel ratio and pauses every timeline", () => {
  vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(3);
  const { canvas, context, image } = canvasFixture();
  const before = gsap.globalTimeline.getChildren().length;
  const scene = createCrowdScene(canvas, image);
  expect(scene).not.toBeNull();
  expect(canvas.width).toBe(1200);
  expect(canvas.height).toBe(440);
  expect(context.drawImage).toHaveBeenCalledTimes(24);
  for (const args of context.drawImage.mock.calls) {
    expect(args[1]).toBeGreaterThanOrEqual(0);
    expect(args[2]).toBeGreaterThanOrEqual(0);
    expect(args[1] + args[3]).toBeLessThanOrEqual(3600);
    expect(args[2] + args[4]).toBeLessThanOrEqual(2268);
    expect(args[3]).toBe(240);
    expect(args[4]).toBe(324);
  }
  scene?.setPlaying(true);
  expect(canvas.dataset.crowdPlaying).toBe("true");
  scene?.setPlaying(false);
  expect(canvas.dataset.crowdPlaying).toBe("false");
  const timelines = gsap.globalTimeline
    .getChildren(false, false, true)
    .slice(-48);
  expect(timelines.every((timeline) => timeline.paused())).toBe(true);
  scene?.destroy();
  expect(gsap.globalTimeline.getChildren()).toHaveLength(before);
  context.drawImage.mockClear();
  scene?.resize();
  scene?.setPlaying(true);
  expect(context.drawImage).not.toHaveBeenCalled();
});

it("rebuilds on container resize, but reuses the current scene for identical bounds", () => {
  const { canvas, context, image } = canvasFixture();
  const scene = createCrowdScene(canvas, image);
  const calls = context.drawImage.mock.calls.length;
  scene?.resize();
  expect(context.drawImage).toHaveBeenCalledTimes(calls);
  Object.defineProperty(canvas, "clientWidth", { value: 300 });
  scene?.resize();
  expect(context.drawImage).toHaveBeenCalledTimes(calls + 12);
  scene?.destroy();
});
