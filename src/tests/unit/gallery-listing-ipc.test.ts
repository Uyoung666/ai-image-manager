import { MessageChannel } from "node:worker_threads";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import { call, type RouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/message-port";
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

async function withListingClient(
  run: (
    client: RouterClient<{ listPhotoPage: typeof listPhotoPage }>
  ) => Promise<void>
) {
  const { port1, port2 } = new MessageChannel();
  new RPCHandler({ listPhotoPage }).upgrade(port1);
  const client = createORPCClient<
    RouterClient<{ listPhotoPage: typeof listPhotoPage }>
  >(new RPCLink({ port: port2 }));
  port1.start();
  port2.start();
  try {
    await run(client);
  } finally {
    port1.close();
    port2.close();
  }
}

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
    expect(listing.describe).not.toHaveBeenCalled();
    expect(await call(getPhotosByIds, { ids: [1] })).toEqual(items);
    expect(listing.describe).not.toHaveBeenCalled();
    expect(await call(listPhotoPage, { layoutOnly: true })).toEqual(page);
    expect(listing.describe).not.toHaveBeenCalled();
  });

  it("reads current file identities only for the requested thumbnail IDs", async () => {
    listing.byIds.mockReturnValue([{ id: 2, path: "visible.webp" }]);
    listing.describe.mockResolvedValue([{ id: 2, thumbnailVersion: "fresh" }]);
    expect(await call(getPhotoThumbnailVersions, { ids: [2] })).toEqual([
      { id: 2, thumbnailVersion: "fresh" },
    ]);
    expect(listing.byIds).toHaveBeenCalledWith([2]);
    expect(listing.describe).toHaveBeenCalledWith(
      [{ id: 2, path: "visible.webp" }],
      2,
      undefined
    );
    await call(getPhotoThumbnailVersions, { ids: [2], priority: 0 });
    expect(listing.describe).toHaveBeenLastCalledWith(
      [{ id: 2, path: "visible.webp" }],
      0,
      undefined
    );
  });

  it("preserves the expired-cursor error across the message-port transport", async () => {
    listing.page.mockImplementation(() => {
      throw new Error("GALLERY_CURSOR_EXPIRED");
    });
    await withListingClient(async (client) => {
      await expect(
        client.listPhotoPage({ cursor: "previous-page", layoutOnly: true })
      ).rejects.toMatchObject({
        code: "GALLERY_CURSOR_EXPIRED",
        status: 409,
        message: "GALLERY_CURSOR_EXPIRED",
      });
    });
    expect(listing.describe).not.toHaveBeenCalled();
  });

  it("keeps unexpected server failures separate from cursor expiry", async () => {
    listing.page.mockImplementation(() => {
      throw new Error("Private database failure");
    });
    await withListingClient(async (client) => {
      await expect(
        client.listPhotoPage({ cursor: "previous-page" })
      ).rejects.toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
        status: 500,
        message: "Internal server error",
      });
    });
  });
});
