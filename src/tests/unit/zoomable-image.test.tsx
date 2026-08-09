import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  ZoomableImage,
  type ZoomableImageHandle,
} from "@/components/ZoomableImage";

vi.mock("@/utils/local-media-url", () => ({
  toDuelPreviewUrl: (path: string) => `http://media.test/duel/${path}`,
  toLocalMediaUrl: (path: string) => `http://media.test/image/${path}`,
  toPreviewUrl: (path: string) => `http://media.test/preview/${path}`,
}));

describe("ZoomableImage", () => {
  it("keeps the thumbnail while a duel preview is still pending", () => {
    render(
      <ZoomableImage
        alt="photo"
        enableOriginalOnZoom
        enableProgressiveLoading
        filePath="original.jpg"
        thumbnailPath="thumbnail.webp"
      />
    );

    const image = screen.getByRole("img", { name: "photo" });
    expect(image).toHaveAttribute(
      "src",
      "http://media.test/image/thumbnail.webp"
    );

    fireEvent.load(image);

    expect(image).toHaveAttribute(
      "src",
      "http://media.test/image/thumbnail.webp"
    );
  });

  it("uses the original as preview only after the strategy confirms it", () => {
    render(
      <ZoomableImage
        alt="photo"
        enableProgressiveLoading
        filePath="original.jpg"
        thumbnailPath="thumbnail.webp"
        useOriginalAsPreview
      />
    );

    const image = screen.getByRole("img", { name: "photo" });
    fireEvent.load(image);

    expect(image).toHaveAttribute(
      "src",
      "http://media.test/image/original.jpg"
    );
    expect(image).not.toHaveClass("transition-all");
  });

  it("coalesces continuous wheel updates into one animation frame", () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    const frameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      });
    const onSync = vi.fn();

    render(
      <ZoomableImage
        alt="photo"
        filePath="original.jpg"
        onSync={onSync}
        thumbnailPath="thumbnail.webp"
      />
    );

    const container = screen.getByRole("img", { name: "photo" }).parentElement;
    expect(container).not.toBeNull();

    fireEvent.wheel(container as HTMLElement, { deltaY: -100 });
    fireEvent.wheel(container as HTMLElement, { deltaY: -100 });
    fireEvent.wheel(container as HTMLElement, { deltaY: -100 });

    expect(frameCallbacks).toHaveLength(1);
    expect(onSync).not.toHaveBeenCalled();

    act(() => frameCallbacks[0](performance.now()));

    expect(onSync).toHaveBeenCalledTimes(1);
    expect(onSync.mock.calls[0][0].scale).toBeCloseTo(1.15 ** 3);
    frameSpy.mockRestore();
  });

  it("does not read layout during continuous wheel frames", () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    const frameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      });
    render(
      <ZoomableImage
        alt="photo"
        filePath="original.jpg"
        thumbnailPath="thumbnail.webp"
      />
    );

    const image = screen.getByRole("img", { name: "photo" });
    const container = image.parentElement as HTMLElement;
    const layoutReads = vi.fn(() => 1200);
    Object.defineProperty(container, "clientWidth", { get: layoutReads });
    Object.defineProperty(container, "clientHeight", { get: layoutReads });
    Object.defineProperty(image, "naturalWidth", { get: () => 4000 });
    Object.defineProperty(image, "naturalHeight", { get: () => 3000 });
    fireEvent.load(image);
    layoutReads.mockClear();

    fireEvent.wheel(container, { deltaY: -100 });
    fireEvent.wheel(container, { deltaY: -100 });

    expect(layoutReads).not.toHaveBeenCalled();
    act(() => frameCallbacks[0](performance.now()));
    frameSpy.mockRestore();
  });

  it("applies synchronized transforms through the imperative handle", () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    const frameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      });
    const ref = createRef<ZoomableImageHandle>();
    const onSync = vi.fn();
    render(
      <ZoomableImage
        alt="photo"
        filePath="original.jpg"
        onSync={onSync}
        ref={ref}
      />
    );

    act(() => {
      ref.current?.applySync({ scale: 2, translate: { x: 40, y: 20 } });
      frameCallbacks[0](performance.now());
    });

    expect(screen.getByRole("img", { name: "photo" })).toHaveStyle({
      transform: "scale(2) translate(20px, 10px)",
    });
    expect(onSync).not.toHaveBeenCalled();
    frameSpy.mockRestore();
  });

  it("cancels inertia frames when it unmounts", () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    const frameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      });
    const cancelSpy = vi.spyOn(window, "cancelAnimationFrame");
    const performanceSpy = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValue(16);
    const { unmount } = render(
      <ZoomableImage alt="photo" filePath="original.jpg" />
    );
    const image = screen.getByRole("img", { name: "photo" });

    fireEvent.keyDown(document, { key: "+" });
    fireEvent.mouseDown(image, { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 100, clientY: 0 });
    fireEvent.mouseUp(window);

    expect(frameCallbacks.length).toBeGreaterThan(0);
    const inertiaFrame = frameCallbacks.length;
    unmount();

    expect(cancelSpy).toHaveBeenCalledWith(inertiaFrame);
    frameSpy.mockRestore();
    cancelSpy.mockRestore();
    performanceSpy.mockRestore();
  });
});
