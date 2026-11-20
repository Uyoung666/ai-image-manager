import { renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useBrowsePrefetch } from "@/hooks/use-browse-image";
import { browseMedia, browseNeighborIndices } from "@/utils/browse-image";

const photos = Array.from({ length: 8 }, (_, index) => ({
  id: index + 1,
  width: 4032,
  height: 3024,
  path: `C:/Photos/image-${index + 1}.heic`,
  thumbnailVersion: "known-source",
}));
const area = { width: 900, height: 600 };

afterEach(() => vi.unstubAllGlobals());

it("chooses an image tier for the fitted photo in physical pixels", () => {
  const photo = photos[0];
  expect(browseMedia(photo, area, 1).edge).toBe(1024);
  expect(browseMedia(photo, area, 3).fit).toContain("edge=4096");
  expect(
    browseMedia({ ...photo, path: "C:/Photos/animation.gif" }, area, 1)
  ).toMatchObject({ direct: true, prefetch: false });
  expect(
    browseMedia(
      { ...photo, path: "C:/Photos/small.jpg", width: 256, height: 192 },
      area,
      1
    ).direct
  ).toBe(true);
  expect(
    browseMedia({ ...photo, path: "C:/Photos/phone.jpg" }, area, 1)
  ).toMatchObject({ direct: true, prefetch: false });
  expect(
    browseMedia(
      { ...photo, path: "C:/Photos/large.jpg", width: 7000, height: 5000 },
      area,
      1
    )
  ).toMatchObject({ direct: false, prefetch: true });
});

it("orders neighbors by direction and preserves each viewer's boundary policy", () => {
  expect(browseNeighborIndices(8, 3, 1, false)).toEqual([4, 5, 2]);
  expect(browseNeighborIndices(8, 3, -1, false)).toEqual([2, 1, 4]);
  expect(browseNeighborIndices(8, 7, 1, true)).toEqual([0, 1, 6]);
  expect(browseNeighborIndices(8, 7, 1, false)).toEqual([6]);
});

it("warms the foreground URL and cancels a speculative request after a jump or close", () => {
  const fetch = vi.fn(
    (_url: string, { signal }: RequestInit) =>
      new Promise<Response>((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      })
  );
  vi.stubGlobal("fetch", fetch);
  const { rerender, unmount } = renderHook(
    ({ index, ready }) =>
      useBrowsePrefetch(photos, index, area, 1, true, false, ready),
    { initialProps: { index: 2, ready: false } }
  );
  expect(fetch).not.toHaveBeenCalled();
  rerender({ index: 2, ready: true });
  expect(fetch.mock.calls[0][0]).toBe(browseMedia(photos[3], area, 1).fit);
  rerender({ index: 6, ready: false });
  expect(fetch.mock.calls[0][1].signal?.aborted).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  rerender({ index: 6, ready: true });
  expect(fetch.mock.calls[1][0]).toBe(browseMedia(photos[7], area, 1).fit);
  unmount();
  expect(fetch.mock.calls[1][1].signal?.aborted).toBe(true);
});
