import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listing = vi.hoisted(() => ({
  page: vi.fn(),
  byIds: vi.fn(),
  prefix: vi.fn(),
  describe: vi.fn(),
}));
vi.mock("@/services/gallery-listing", () => ({
  listGalleryPhotos: listing.page,
  getGalleryPhotosByIds: listing.byIds,
  getGalleryLayoutPrefix: listing.prefix,
}));
vi.mock("@/services/thumbnail-identity", () => ({
  describeGalleryThumbnails: listing.describe,
}));

import {
  getPhotosByIds,
  getPhotoThumbnailVersions,
  listPhotoPage,
} from "@/ipc/photos/handlers/gallery-listing";

describe("gallery listing IPC", () => {
  beforeEach(() => vi.resetAllMocks());

  it("does not wait for an entire page or bulk operation's source files", async () => {
    const items = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      path: `fixture-${index}.webp`,
      width: 300,
      height: 200,
    }));
    const page = { items, nextCursor: null, total: 100 };
    listing.page.mockReturnValue(page);
    listing.byIds.mockReturnValue(items);
    listing.describe.mockImplementation((records) =>
      records.length > 24
        ? new Promise(() => undefined)
        : Promise.resolve(records)
    );
    expect(await call(listPhotoPage, {})).toEqual(page);
    expect(listing.describe).toHaveBeenCalledTimes(1);
    expect(listing.describe).toHaveBeenCalledWith(items.slice(0, 24));
    expect(await call(getPhotosByIds, { ids: [1] })).toEqual(items);
    expect(listing.describe).toHaveBeenCalledTimes(1);
    expect(await call(listPhotoPage, { layoutOnly: true })).toEqual(page);
    expect(listing.describe).toHaveBeenCalledTimes(1);
  });

  it("reads current file identities only for the requested thumbnail IDs", async () => {
    listing.byIds.mockReturnValue([{ id: 2, path: "visible.webp" }]);
    listing.describe.mockResolvedValue([{ id: 2, thumbnailVersion: "fresh" }]);
    expect(await call(getPhotoThumbnailVersions, { ids: [2] })).toEqual([
      { id: 2, thumbnailVersion: "fresh" },
    ]);
    expect(listing.byIds).toHaveBeenCalledWith([2]);
    expect(listing.describe).toHaveBeenCalledWith([
      { id: 2, path: "visible.webp" },
    ]);
  });
});
