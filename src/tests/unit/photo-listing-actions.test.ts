import { expect, it, vi } from "vitest";
import { photoListingActions } from "@/actions/photo-listing";

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("@/ipc/manager", () => ({
  ipc: { client: { photos: { getPhotosByIds: lookup } } },
}));

it("can read more than 1000 changed photos for one culling review", async () => {
  const ids = Array.from({ length: 1001 }, (_, index) => index + 1);
  lookup.mockImplementation(({ ids: batch }: { ids: number[] }) => {
    if (batch.length > 1000) {
      throw new Error("Over the photo lookup IPC limit");
    }
    return Promise.resolve(
      batch.filter((id) => id !== 9).map((id) => ({ id }))
    );
  });

  const photos = await photoListingActions.byIds([...ids, 1]);

  expect(photos.map(({ id }) => id)).toEqual(ids.filter((id) => id !== 9));
});
