import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGalleryModeTransition } from "@/hooks/useGalleryModeTransition";

interface ImageRequest {
  fail: () => void;
  finish: () => void;
  image: { src: string };
}

const requests: ImageRequest[] = [];

beforeEach(() => {
  requests.length = 0;
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      decode() {
        return new Promise<void>((resolve, reject) => {
          requests.push({
            image: this,
            finish: resolve,
            fail: () => reject(new Error("Image unavailable")),
          });
        });
      }
    }
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function gallery() {
  const surface = document.createElement("div");
  const scroll = document.createElement("div");
  scroll.dataset.masonryScroll = "";
  scroll.getBoundingClientRect = () => new DOMRect(0, 0, 900, 600);
  surface.append(scroll);
  const add = (name: string, top = 100, srcset = "") => {
    const image = document.createElement("img");
    image.src = `http://localhost/thumbnail/${name}.webp`;
    image.srcset = srcset;
    image.getBoundingClientRect = () => new DOMRect(0, top, 160, 100);
    scroll.append(image);
    return image.src;
  };
  return { add, scroll, surfaceRef: { current: surface } };
}

function switchBack(target = gallery()) {
  const onCommit = vi.fn();
  const initialProps = {
    currentMode: "photos" as "photos" | "sequences",
    nextMode: "sequences" as "photos" | "sequences",
    renderedScopeKey: "folder-1",
    scopeKey: "folder-1",
  };
  const hook = renderHook(
    (props) =>
      useGalleryModeTransition({
        ...props,
        onCommit,
        surfaceRef: target.surfaceRef,
      }),
    { initialProps }
  );
  expect(onCommit).toHaveBeenCalledWith("sequences");
  onCommit.mockClear();
  target.scroll.replaceChildren();
  const returning = {
    ...initialProps,
    currentMode: "sequences" as const,
    nextMode: "photos" as const,
  };
  hook.rerender(returning);
  return { ...hook, onCommit, returning };
}

describe("gallery mode image restoration", () => {
  it("waits for fresh decoding of the returning viewport, including responsive sources", async () => {
    const target = gallery();
    const small = "http://localhost/thumbnail/small.webp";
    const visible = target.add("visible", 100, `${small} 256w`);
    target.add("above", -200);
    target.add("below", 700);
    const { onCommit } = switchBack(target);

    expect(requests.map(({ image }) => image.src)).toEqual([visible, small]);
    expect(onCommit).not.toHaveBeenCalled();
    await act(async () => requests[0].finish());
    expect(onCommit).not.toHaveBeenCalled();
    await act(async () => requests[1].finish());
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("photos");
  });

  it("cancels preparation when the user switches back before decoding finishes", async () => {
    const target = gallery();
    target.add("visible");
    const { onCommit, rerender, returning } = switchBack(target);
    rerender({ ...returning, nextMode: "sequences" });
    expect(requests[0].image.src).toBe("");
    await act(async () => requests[0].finish());
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("rechecks the actual resource on each return instead of trusting a remembered URL", async () => {
    const target = gallery();
    target.add("visible");
    const { onCommit, rerender, returning } = switchBack(target);
    await act(async () => requests[0].finish());
    rerender({ ...returning, currentMode: "photos" });
    target.add("visible");
    rerender({
      ...returning,
      currentMode: "photos",
      nextMode: "sequences",
    });
    target.scroll.replaceChildren();
    onCommit.mockClear();
    rerender(returning);
    expect(requests).toHaveLength(2);
    expect(onCommit).not.toHaveBeenCalled();
    await act(async () => requests[1].finish());
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("photos");
  });

  it("drops old folder sources and ignores their late completion", async () => {
    const target = gallery();
    target.add("old-folder");
    const { onCommit, rerender, returning } = switchBack(target);
    rerender({ ...returning, scopeKey: "folder-2" });
    expect(requests[0].image.src).toBe("");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("photos");
    await act(async () => requests[0].finish());
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("cancels outstanding image requests when the gallery unmounts", async () => {
    const target = gallery();
    target.add("visible");
    const { onCommit, unmount } = switchBack(target);
    unmount();
    expect(requests[0].image.src).toBe("");
    await act(async () => requests[0].finish());
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("lets the normal image error UI handle a missing thumbnail", async () => {
    const target = gallery();
    target.add("deleted");
    const { onCommit } = switchBack(target);
    await act(async () => requests[0].fail());
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("photos");
  });

  it("bounds requests and stops waiting when image loading stalls", async () => {
    vi.useFakeTimers();
    const target = gallery();
    for (let index = 0; index < 20; index++) {
      target.add(`visible-${index}`);
    }
    const { onCommit } = switchBack(target);
    expect(requests).toHaveLength(4);
    expect(onCommit).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(requests).toHaveLength(4);
    expect(requests.every(({ image }) => image.src === "")).toBe(true);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("photos");
  });

  it("commits immediately when the previous mode has no images", () => {
    const { onCommit } = switchBack();
    expect(requests).toHaveLength(0);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("photos");
  });
});
