import { act, cleanup, render } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhotoCard } from "@/components/PhotoCard";
import {
  type ImageLoadResult,
  releaseImageGeneration,
} from "@/utils/image-scheduler";

const results = vi.hoisted(
  () => [] as Array<{ generation?: string | number; result: ImageLoadResult }>
);
vi.mock("@/utils/image-scheduler", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/utils/image-scheduler")>();
  return {
    ...actual,
    scheduleImage: (...args: Parameters<typeof actual.scheduleImage>) => {
      const handle = actual.scheduleImage(...args);
      handle.promise.then((result) =>
        results.push({ generation: args[1]?.generation, result })
      );
      return handle;
    },
  };
});
vi.mock("@/utils/gallery-image-observer", () => ({
  getGalleryDpr: () => 1,
  subscribeGalleryDpr: () => () => undefined,
  observeGalleryImage: () => () => undefined,
}));
vi.mock("@/utils/local-media-url", () => ({
  toGalleryThumbnailUrl: (
    id: number,
    edge: number,
    version: string,
    source?: string,
    select?: boolean,
    repair?: boolean
  ) => `http://gallery/${id}/${edge}/${version}/${source}/${select}/${repair}`,
}));

const readyUrls = new Set<string>();
class NativeImage {
  static created: NativeImage[] = [];
  complete = false;
  naturalWidth = 0;
  naturalHeight = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = "";

  constructor() {
    NativeImage.created.push(this);
  }

  finish() {
    if (!this.src || this.complete) {
      return;
    }
    this.complete = true;
    this.naturalWidth = 512;
    this.naturalHeight = 512;
    readyUrls.add(this.src);
    this.onload?.();
  }
}

function Gallery({ generation, ids }: { generation: string; ids: number[] }) {
  useEffect(() => () => releaseImageGeneration(generation), [generation]);
  return ids.map((id) => (
    <PhotoCard
      filename={`photo-${id}.jpg`}
      height={400}
      id={id}
      imageHeight={220}
      imageIdle={false}
      imageVisible
      imageWidth={220}
      isSelected={false}
      key={id}
      loading="eager"
      onClick={vi.fn()}
      onDoubleClick={vi.fn()}
      path={`photo-${id}.jpg`}
      queryGeneration={generation}
      thumbnailPath={null}
      width={400}
    />
  ));
}

function view(generation: string, ids: number[]) {
  return (
    <StrictMode>
      <Gallery generation={generation} ids={ids} />
    </StrictMode>
  );
}

async function finishImages() {
  for (let wave = 0; wave < 4; wave++) {
    await act(async () => {
      for (const image of [...NativeImage.created]) {
        image.finish();
      }
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  results.length = 0;
  NativeImage.created = [];
  readyUrls.clear();
  vi.stubGlobal("Image", NativeImage);
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockImplementation(
    function (this: HTMLImageElement) {
      return readyUrls.has(this.src);
    }
  );
  vi.spyOn(
    HTMLImageElement.prototype,
    "naturalWidth",
    "get"
  ).mockImplementation(function (this: HTMLImageElement) {
    return readyUrls.has(this.src) ? 512 : 0;
  });
});
afterEach(() => {
  cleanup();
  for (const image of NativeImage.created) {
    image.complete = false;
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("photo card thumbnail generation handoff", () => {
  it.each([
    "pending",
    "loaded",
    "same-commit",
  ])("reveals Favorites on its first visit when previous images are %s", async (timing) => {
    const gallery = render(view("all", [1, 2, 3, 4, 5, 6, 7, 8]));
    if (timing === "loaded") {
      await finishImages();
    }
    await act(async () => {
      if (timing === "same-commit") {
        for (const image of [...NativeImage.created]) {
          image.finish();
        }
      }
      gallery.rerender(view("favorites", [1, 2]));
      await Promise.resolve();
    });
    await finishImages();

    expect(gallery.container.querySelectorAll("img")).toHaveLength(2);
    expect(
      gallery.container.querySelectorAll('img[data-load-state="loaded"]')
    ).toHaveLength(2);
    expect(results.filter((entry) => entry.generation === "favorites")).toEqual(
      [
        { generation: "favorites", result: "loaded" },
        { generation: "favorites", result: "loaded" },
      ]
    );
  });

  it("ignores late old loads through rapid All/Favorites switches and cache hits", async () => {
    const gallery = render(view("all", [1, 2, 3, 4, 5, 6, 7, 8]));
    const lateLoads = NativeImage.created.map((image) => image.onload);
    gallery.rerender(view("favorites", [1, 2]));
    gallery.rerender(view("all", [1, 2, 3, 4, 5, 6, 7, 8]));
    gallery.rerender(view("favorites", [1, 2]));
    await act(async () => {
      for (const lateLoad of lateLoads) {
        lateLoad?.();
      }
      await Promise.resolve();
    });
    await finishImages();
    expect(
      gallery.container.querySelectorAll('img[data-load-state="loaded"]')
    ).toHaveLength(2);

    gallery.rerender(view("all", [1, 2, 3, 4, 5, 6, 7, 8]));
    await finishImages();
    gallery.rerender(view("favorites", [1, 2]));
    await finishImages();
    expect(
      gallery.container.querySelectorAll('img[data-load-state="loaded"]')
    ).toHaveLength(2);
  });
});
