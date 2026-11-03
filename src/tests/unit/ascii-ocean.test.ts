import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isOceanBackground,
  OceanEngine,
  type OceanOptions,
  sharkRoster,
} from "@/plugins/builtins/ascii-ocean/engine";
import { World } from "@/plugins/builtins/ascii-ocean/world";
import { ASCII_OCEAN_MANIFEST } from "@/plugins/builtins/ascii-ocean-manifest";
import {
  parsePluginManifestV2,
  validatePluginSettings,
} from "@/plugins/manifest";

const renderer = vi.hoisted(() => ({
  render: vi.fn(),
  resize: vi.fn(),
  dispose: vi.fn(),
  setDark: vi.fn(),
}));
vi.mock("@/plugins/builtins/ascii-ocean/renderer", () => ({
  AsciiRenderer: class {
    cellWidth = 10;
    cellHeight = 14;
    render = renderer.render;
    resize = renderer.resize;
    dispose = renderer.dispose;
    setDark = renderer.setDark;
    setFontFamily = vi.fn();
  },
}));

const options: OceanOptions = {
  dark: true,
  fishCount: 20,
  interactive: true,
  reducedMotion: false,
  sharkCount: 3,
  species: "mixed",
  speed: 0.75,
};
let engine: OceanEngine | undefined;
let frame: FrameRequestCallback;
let intersection: IntersectionObserverCallback;
const motion = {
  matches: false,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
};
const disconnect = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  motion.matches = false;
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => motion)
  );
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      frame = callback;
      return 7;
    })
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      disconnect = disconnect;
    }
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersection = callback;
      }
      observe = vi.fn();
      disconnect = disconnect;
    }
  );
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});

afterEach(() => {
  engine?.destroy();
  engine = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function start(overrides: Partial<OceanOptions> = {}, onError = vi.fn()) {
  const canvas = document.createElement("canvas");
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
    width: 3200,
    height: 2000,
    left: 0,
    top: 0,
  } as DOMRect);
  engine = new OceanEngine(canvas, { ...options, ...overrides }, onError);
  return engine;
}

describe("ASCII Ocean", () => {
  it("resizes sharks without reseeding a zero-fish ocean", () => {
    const world = new World(sharkRoster("mixed", 3), 0);
    world.resize(1280, 800, 10, 14);
    const shark = world.sharks[0];
    const originalLength = shark.length;
    world.resize(720, 480, 8, 12);
    expect(world.fish).toHaveLength(0);
    expect(world.sharks[0]).toBe(shark);
    expect(shark.length).toBeLessThan(originalLength);
    expect(world.sharks).toHaveLength(3);
  });
  it("validates the v2 manifest, defaults and setting boundaries", () => {
    const { theme, ...manifest } = ASCII_OCEAN_MANIFEST;
    expect(parsePluginManifestV2(manifest, theme).settings).toHaveLength(8);
    expect(validatePluginSettings(ASCII_OCEAN_MANIFEST, {})).toMatchObject({
      sharkCount: 3,
      fishCount: 80,
      speed: 0.75,
      intensity: 45,
      blur: 10,
      opacity: 65,
      interactive: true,
    });
    expect(
      validatePluginSettings(ASCII_OCEAN_MANIFEST, {
        sharkCount: 99,
        fishCount: -1,
        species: "invalid",
        speed: Number.NaN,
      })
    ).toMatchObject({
      sharkCount: 4,
      fishCount: 0,
      species: "mixed",
      speed: 0.75,
    });
    expect(sharkRoster("mixed", 4).map((shark) => shark.kind)).toEqual([
      "classic",
      "hammerhead",
      "thresher",
      "tiger",
    ]);
  });

  it("requires a direct background hit and ignores controls, media and overlays", () => {
    const background = document.createElement("div");
    background.dataset.oceanBackground = "true";
    const button = document.createElement("button");
    background.append(button);
    expect(isOceanBackground(background)).toBe(true);
    expect(isOceanBackground(button)).toBe(false);
    background.setAttribute("inert", "");
    expect(isOceanBackground(background)).toBe(false);
    background.removeAttribute("inert");
    background.dataset.surface = "media-well";
    expect(isOceanBackground(background)).toBe(false);
  });

  it("limits render resolution and frame rate, pauses offscreen and releases resources", () => {
    const active = start();
    expect(renderer.resize).toHaveBeenCalledWith(
      1600,
      1000,
      expect.any(Number)
    );
    renderer.render.mockClear();
    frame(100);
    frame(116);
    frame(140);
    expect(renderer.render).toHaveBeenCalledTimes(1);
    const requests = vi.mocked(requestAnimationFrame).mock.calls.length;
    intersection(
      [{ isIntersecting: false }] as IntersectionObserverEntry[],
      {} as IntersectionObserver
    );
    expect(cancelAnimationFrame).toHaveBeenCalledWith(7);
    expect(vi.mocked(requestAnimationFrame).mock.calls).toHaveLength(requests);
    intersection(
      [{ isIntersecting: true }] as IntersectionObserverEntry[],
      {} as IntersectionObserver
    );
    renderer.render.mockClear();
    frame(10_000);
    expect(renderer.render).not.toHaveBeenCalled();
    active.destroy();
    active.destroy();
    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
    expect(motion.removeEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function)
    );
  });

  it("shows still frames for app or system reduced motion and updates the palette live", () => {
    const active = start({ reducedMotion: true });
    expect(renderer.render).toHaveBeenCalled();
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    active.setOptions({ ...options, dark: false });
    expect(renderer.setDark).toHaveBeenLastCalledWith(false);
    expect(requestAnimationFrame).toHaveBeenCalled();
    motion.matches = true;
    vi.mocked(requestAnimationFrame).mockClear();
    active.setOptions(options);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it("filters clicks and dragging and removes pointer listeners on disposal", () => {
    const splash = vi.spyOn(World.prototype, "splash");
    const active = start();
    const background = document.createElement("div");
    background.dataset.oceanBackground = "true";
    const button = document.createElement("button");
    background.append(button);
    document.body.append(background);
    const click = (target: HTMLElement) => {
      for (const type of ["pointerdown", "pointerup"]) {
        target.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            clientX: 20,
            clientY: 20,
          })
        );
      }
    };
    click(button);
    expect(splash).not.toHaveBeenCalled();
    click(background);
    expect(splash).toHaveBeenCalledTimes(1);
    background.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, clientX: 20, clientY: 20 })
    );
    background.dispatchEvent(
      new MouseEvent("pointermove", {
        bubbles: true,
        clientX: 60,
        clientY: 20,
        buttons: 1,
      })
    );
    background.dispatchEvent(
      new MouseEvent("pointerup", { bubbles: true, clientX: 60, clientY: 20 })
    );
    expect(splash).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("dragstart"));
    click(background);
    expect(splash).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("dragend"));
    active.setOptions({ ...options, interactive: false });
    click(background);
    expect(splash).toHaveBeenCalledTimes(1);
    active.destroy();
    click(background);
    expect(splash).toHaveBeenCalledTimes(1);
  });

  it("stops after a render failure and reports it once", () => {
    const onError = vi.fn();
    start({}, onError);
    renderer.render.mockImplementationOnce(() => {
      throw new Error("render failed");
    });
    frame(100);
    frame(150);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
    frame(200);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
