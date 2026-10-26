/** @vitest-environment node */
import { MessageChannel } from "node:worker_threads";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import type { RouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/message-port";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  layout: vi.fn(),
  requestLayout: vi.fn(),
  info: vi.fn(),
  context: vi.fn(),
  append: vi.fn(),
  ensureRange: vi.fn(),
}));
vi.mock("@/services/gallery-albums", () => ({
  getGalleryAlbumInfo: vi.fn(),
  getGalleryAlbumLayout: state.layout,
  getGalleryAlbumPage: vi.fn(),
}));
vi.mock("@/services/album-recents", () => ({
  getRecentAlbums: vi.fn(),
  rememberAlbum: vi.fn(),
}));
vi.mock("@/services/smart-album-engine", () => ({
  evaluateSmartAlbum: vi.fn(),
  validateSmartRules: vi.fn(),
}));
vi.mock("@/db", () => ({ getDatabase: vi.fn() }));
vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      albums: {
        getAlbumInfo: state.info,
        getAlbumLayout: state.requestLayout,
      },
    },
  },
}));
vi.mock("@/actions/photo-listing", () => ({
  photoListingActions: { byIds: vi.fn() },
}));
vi.mock("@/utils/gallery-data-source", () => ({
  galleryContext: state.context,
}));

import { getWindowedAlbum } from "@/actions/albums";
import { getAlbumLayout } from "@/ipc/albums/handlers";

type LayoutClient = RouterClient<{ getAlbumLayout: typeof getAlbumLayout }>;
async function withLayoutClient(run: (client: LayoutClient) => Promise<void>) {
  const { port1, port2 } = new MessageChannel();
  new RPCHandler({ getAlbumLayout }).upgrade(port1);
  const client = createORPCClient<LayoutClient>(new RPCLink({ port: port2 }));
  port1.start();
  port2.start();
  state.requestLayout.mockImplementation((input) =>
    client.getAlbumLayout(input)
  );
  try {
    await run(client);
  } finally {
    port1.close();
    port2.close();
  }
}

const info = { id: 1, name: "Album", description: null, coverPhotoId: null };
const items = [{ id: 1, width: 100, height: 150, fileDate: null }];
const layout = { id: "snapshot", items, revision: "2:" };
beforeEach(() => {
  vi.resetAllMocks();
  state.info.mockResolvedValue(info);
  state.layout.mockResolvedValue(layout);
  state.context.mockReturnValue({
    append: state.append,
    ensureRange: state.ensureRange,
  });
  state.append.mockReturnValue(items);
  state.ensureRange.mockResolvedValue(undefined);
});

describe("album layout snapshot recovery", () => {
  it("preserves snapshot expiry across the real message-port transport", async () => {
    state.layout.mockRejectedValue(new Error("ALBUM_SNAPSHOT_EXPIRED"));
    await withLayoutClient(async (client) => {
      await expect(
        client.getAlbumLayout({ id: 1, sort: "date", order: "desc" })
      ).rejects.toMatchObject({
        code: "ALBUM_SNAPSHOT_EXPIRED",
        status: 409,
        message: "ALBUM_SNAPSHOT_EXPIRED",
      });
    });
  });

  it.each([
    1, 2,
  ])("recovers after %i expired layout attempts without publishing the stale snapshot", async (expired) => {
    for (let attempt = 0; attempt < expired; attempt++) {
      state.layout.mockRejectedValueOnce(new Error("ALBUM_SNAPSHOT_EXPIRED"));
    }
    await withLayoutClient(async () => {
      await expect(
        getWindowedAlbum(1, "date", "desc", "zh-CN")
      ).resolves.toEqual({
        ...info,
        galleryOrder: true,
        photos: items,
        matchCount: 1,
      });
    });
    expect(state.layout).toHaveBeenCalledTimes(expired + 1);
    expect(state.layout).toHaveBeenLastCalledWith({
      id: 1,
      sort: "date",
      order: "desc",
      locale: "zh-CN",
    });
    expect(state.info).toHaveBeenCalledOnce();
    expect(state.context).toHaveBeenCalledOnce();
    expect(state.context.mock.calls[0][0]).toBe("album:snapshot");
    expect(state.append).toHaveBeenCalledExactlyOnceWith(items);
    expect(state.ensureRange).toHaveBeenCalledExactlyOnceWith(0, 199);
  });

  it("stops after three total layout attempts when the library keeps changing", async () => {
    state.layout.mockRejectedValue(new Error("ALBUM_SNAPSHOT_EXPIRED"));
    await withLayoutClient(async () => {
      await expect(getWindowedAlbum(1, "date", "desc")).rejects.toMatchObject({
        code: "ALBUM_SNAPSHOT_EXPIRED",
      });
    });
    expect(state.layout).toHaveBeenCalledTimes(3);
    expect(state.context).not.toHaveBeenCalled();
    expect(state.ensureRange).not.toHaveBeenCalled();
  });

  it("does not retry unexpected server failures or expose their private messages", async () => {
    state.layout.mockRejectedValue(new Error("Private database failure"));
    await withLayoutClient(async () => {
      await expect(getWindowedAlbum(1, "date", "desc")).rejects.toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
        status: 500,
        message: "Internal server error",
      });
    });
    expect(state.layout).toHaveBeenCalledOnce();
    expect(state.context).not.toHaveBeenCalled();
  });
});
