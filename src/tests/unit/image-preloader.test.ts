import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preloadImagesWithConcurrency } from "@/utils/image-preloader";

class TestImage {
  static instances: TestImage[] = [];
  onerror: (() => void) | null = null;
  onload: (() => void) | null = null;
  private source = "";

  constructor() {
    TestImage.instances.push(this);
  }

  get src() {
    return this.source;
  }

  set src(value: string) {
    this.source = value;
  }
}

describe("image preloader", () => {
  beforeEach(() => {
    TestImage.instances = [];
    vi.stubGlobal("Image", TestImage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("deduplicates duplicate and in-flight URLs", async () => {
    const firstRequest = preloadImagesWithConcurrency(
      ["preload-a", "preload-a", "preload-b"],
      2
    );
    const duplicateRequest = preloadImagesWithConcurrency(["preload-a"], 2);

    expect(TestImage.instances).toHaveLength(2);
    TestImage.instances[0].onload?.();
    TestImage.instances[1].onload?.();

    await expect(firstRequest).resolves.toEqual({ loaded: 2, failed: 0 });
    await expect(duplicateRequest).resolves.toEqual({ loaded: 1, failed: 0 });

    await expect(
      preloadImagesWithConcurrency(["preload-a", "preload-b"], 2)
    ).resolves.toEqual({ loaded: 2, failed: 0 });
    expect(TestImage.instances).toHaveLength(2);
  });

  it("does not cache failures so a failed URL can be retried", async () => {
    const firstRequest = preloadImagesWithConcurrency(["preload-failed"], 1);
    expect(TestImage.instances).toHaveLength(1);
    TestImage.instances[0].onerror?.();
    await expect(firstRequest).resolves.toEqual({ loaded: 0, failed: 1 });

    const retryRequest = preloadImagesWithConcurrency(["preload-failed"], 1);
    expect(TestImage.instances).toHaveLength(2);
    TestImage.instances[1].onload?.();
    await expect(retryRequest).resolves.toEqual({ loaded: 1, failed: 0 });
  });
});
