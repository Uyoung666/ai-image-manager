import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelGalleryViewTransition,
  startGalleryViewTransition,
} from "@/utils/gallery-view-transition";

const originalStartViewTransition = document.startViewTransition;

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: originalStartViewTransition,
  });
  document.documentElement.classList.remove("gallery-mode-transitioning");
  vi.restoreAllMocks();
});

describe("gallery view transition", () => {
  it("updates immediately when the native API is unavailable", () => {
    const update = vi.fn();
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: undefined,
    });

    expect(startGalleryViewTransition(update)).toBeNull();
    expect(update).toHaveBeenCalledOnce();
  });

  it("commits inside the transition and clears its root class", async () => {
    vi.useFakeTimers();
    const update = vi.fn();
    const finished = Promise.resolve();
    const skipTransition = vi.fn();
    const startViewTransition = vi.fn(
      (callback: ViewTransitionUpdateCallback) => {
        callback();
        return { finished, skipTransition } as unknown as ViewTransition;
      }
    );
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: startViewTransition,
    });

    const transition = startGalleryViewTransition(update);

    expect(transition).not.toBeNull();
    expect(startViewTransition).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
    expect(document.documentElement).toHaveClass("gallery-mode-transitioning");
    await finished;
    await Promise.resolve();
    expect(document.documentElement).toHaveClass("gallery-mode-transitioning");
    vi.advanceTimersByTime(220);
    expect(document.documentElement).not.toHaveClass(
      "gallery-mode-transitioning"
    );
  });

  it("cancels an in-flight transition when the gallery unmounts", () => {
    const finished = new Promise<void>(() => undefined);
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: () =>
        ({ finished, skipTransition: vi.fn() }) as unknown as ViewTransition,
    });

    startGalleryViewTransition(vi.fn());
    cancelGalleryViewTransition();

    expect(document.documentElement).not.toHaveClass(
      "gallery-mode-transitioning"
    );
  });
});
