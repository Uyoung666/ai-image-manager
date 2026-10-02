import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelGalleryViewTransition,
  startGalleryViewTransition,
} from "@/utils/gallery-view-transition";

afterEach(() => {
  cancelGalleryViewTransition();
  delete document.documentElement.dataset.reducedMotion;
  vi.restoreAllMocks();
});

function surface() {
  const element = document.createElement("div");
  const animation = {
    cancel: vi.fn(),
    finished: new Promise<void>(() => undefined),
  } as unknown as Animation;
  const animate = vi.fn(() => animation);
  element.animate = animate;
  return { element, animation, animate };
}

describe("gallery view transition", () => {
  it("updates immediately without an animation surface", () => {
    const update = vi.fn();
    expect(startGalleryViewTransition(update)).toBeNull();
    expect(update).toHaveBeenCalledOnce();
  });
  it("animates only the gallery and never requests a document snapshot", () => {
    const target = surface();
    const documentTransition = vi.fn();
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: documentTransition,
    });
    const update = vi.fn();
    expect(startGalleryViewTransition(update, target.element)).toBe(
      target.animation
    );
    expect(update).toHaveBeenCalledOnce();
    expect(target.animate).toHaveBeenCalledOnce();
    expect(documentTransition).not.toHaveBeenCalled();
  });
  it("cancels old animations on consecutive changes and on unmount", () => {
    const first = surface();
    const second = surface();
    startGalleryViewTransition(vi.fn(), first.element);
    startGalleryViewTransition(vi.fn(), second.element);
    expect(first.animation.cancel).toHaveBeenCalledOnce();
    cancelGalleryViewTransition();
    expect(second.animation.cancel).toHaveBeenCalledOnce();
  });
  it("respects reduced motion without delaying the update", () => {
    document.documentElement.dataset.reducedMotion = "true";
    const target = surface();
    const update = vi.fn();
    expect(startGalleryViewTransition(update, target.element)).toBeNull();
    expect(update).toHaveBeenCalledOnce();
    expect(target.animate).not.toHaveBeenCalled();
  });
  it("keeps the committed update if animation creation fails", () => {
    const target = surface();
    target.animate.mockImplementation(() => {
      throw new Error("unsupported");
    });
    const update = vi.fn();
    expect(startGalleryViewTransition(update, target.element)).toBeNull();
    expect(update).toHaveBeenCalledOnce();
  });
});
