import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelThemeViewTransition,
  startThemeViewTransition,
} from "@/utils/theme-view-transition";

const originalTransition = document.startViewTransition;
let control: HTMLElement;

function installTransition() {
  let finish: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const skipTransition = vi.fn(() => finish?.());
  const start = vi.fn((update: () => Promise<void>) => {
    const updateCallbackDone = Promise.resolve().then(update);
    return {
      finished,
      ready: updateCallbackDone,
      skipTransition,
      types: new Set<string>(),
      updateCallbackDone,
    } as ViewTransition;
  });
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: start,
  });
  return { finish: () => finish?.(), skipTransition, start };
}

beforeEach(() => {
  control = document.createElement("label");
  vi.spyOn(control, "getBoundingClientRect").mockReturnValue({
    left: 100,
    top: 200,
    width: 40,
    height: 22,
  } as DOMRect);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false }))
  );
});

afterEach(() => {
  cancelThemeViewTransition();
  delete document.documentElement.dataset.reducedMotion;
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: originalTransition,
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("theme circular view transition", () => {
  it("uses the visible control center and reaches every viewport corner", async () => {
    const transition = installTransition();
    const update = vi.fn(async () => undefined);
    const result = startThemeViewTransition(control, update);
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--theme-reveal-x")).toBe("120px");
    expect(root.style.getPropertyValue("--theme-reveal-y")).toBe("211px");
    const radius = Number.parseFloat(
      root.style.getPropertyValue("--theme-reveal-radius")
    );
    for (const x of [0, window.innerWidth]) {
      for (const y of [0, window.innerHeight]) {
        expect(radius).toBeGreaterThanOrEqual(Math.hypot(x - 120, y - 211));
      }
    }
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(root.dataset.themeTransition).toBe("circle");
    transition.finish();
    await result;
    expect(root.dataset.themeTransition).toBeUndefined();
    expect(root.style.getPropertyValue("--theme-reveal-radius")).toBe("");
  });

  it("waits for async theme application and animation completion", async () => {
    const transition = installTransition();
    let commit: (() => void) | undefined;
    const update = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          commit = resolve;
        })
    );
    const settled = vi.fn();
    const result = startThemeViewTransition(control, update).then(settled);
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(settled).not.toHaveBeenCalled();
    commit?.();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    transition.finish();
    await result;
    expect(settled).toHaveBeenCalledOnce();
  });

  it.each([
    "application",
    "system",
  ])("skips snapshots for %s reduced motion", async (source) => {
    const transition = installTransition();
    if (source === "application") {
      document.documentElement.dataset.reducedMotion = "true";
    } else {
      vi.stubGlobal(
        "matchMedia",
        vi.fn(() => ({ matches: true }))
      );
    }
    const update = vi.fn(async () => undefined);
    await startThemeViewTransition(control, update);
    expect(update).toHaveBeenCalledOnce();
    expect(transition.start).not.toHaveBeenCalled();
  });

  it("falls back without View Transition support", async () => {
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: undefined,
    });
    const update = vi.fn(async () => undefined);
    await startThemeViewTransition(control, update);
    expect(update).toHaveBeenCalledOnce();
  });

  it("applies once when snapshot creation throws after scheduling the callback", async () => {
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: (update: () => Promise<void>) => {
        update();
        throw new Error("snapshot failed");
      },
    });
    const update = vi.fn(async () => undefined);
    await startThemeViewTransition(control, update);
    expect(update).toHaveBeenCalledOnce();
    expect(document.documentElement.dataset.themeTransition).toBeUndefined();
  });

  it("falls back once when snapshot readiness fails before the callback", async () => {
    const skipTransition = vi.fn();
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: () => ({
        finished: Promise.reject(new Error("skipped")),
        ready: Promise.reject(new Error("snapshot failed")),
        skipTransition,
        updateCallbackDone: Promise.reject(new Error("skipped")),
      }),
    });
    const update = vi.fn(async () => undefined);
    await startThemeViewTransition(control, update);
    expect(update).toHaveBeenCalledOnce();
    expect(skipTransition).toHaveBeenCalled();
  });

  it("propagates IPC failure once and cleans animation state", async () => {
    installTransition();
    const error = new Error("IPC failed");
    const update = vi.fn(() => Promise.reject(error));
    await expect(startThemeViewTransition(control, update)).rejects.toBe(error);
    expect(update).toHaveBeenCalledOnce();
    expect(document.documentElement.dataset.themeTransition).toBeUndefined();
  });

  it("cancels on navigation without losing the update", async () => {
    const transition = installTransition();
    const update = vi.fn(async () => undefined);
    const result = startThemeViewTransition(control, update);
    cancelThemeViewTransition();
    expect(transition.skipTransition).toHaveBeenCalled();
    expect(document.documentElement.dataset.themeTransition).toBeUndefined();
    await result;
    expect(update).toHaveBeenCalledOnce();
  });
});
