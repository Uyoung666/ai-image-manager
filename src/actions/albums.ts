import { ORPCError } from "@orpc/client";
import { ipc } from "@/ipc/manager";
import type { Photo } from "@/types/photo";
import { galleryContext } from "@/utils/gallery-data-source";
import { photoListingActions } from "./photo-listing";

export interface AlbumDetail {
  coverPhotoId: number | null;
  description: string | null;
  galleryOrder?: boolean;
  id: number;
  isSmart?: boolean;
  matchCount?: number;
  name: string;
  photos: Photo[];
}

export async function getAlbum(id: number): Promise<AlbumDetail> {
  return (await ipc.client.albums.getAlbum({ id })) as unknown as AlbumDetail;
}

export async function getWindowedAlbum(
  id: number,
  sort: "name" | "date" | "size",
  order: "asc" | "desc",
  locale?: string
): Promise<AlbumDetail> {
  const info = await ipc.client.albums.getAlbumInfo({ id });
  let layout: Awaited<ReturnType<typeof ipc.client.albums.getAlbumLayout>>;
  for (let attempt = 1; ; attempt++) {
    try {
      layout = await ipc.client.albums.getAlbumLayout({
        id,
        sort,
        order,
        locale,
      });
      break;
    } catch (error) {
      if (
        attempt >= 3 ||
        !(error instanceof ORPCError && error.code === "ALBUM_SNAPSHOT_EXPIRED")
      ) {
        throw error;
      }
    }
  }
  const source = galleryContext(
    `album:${layout.id}`,
    photoListingActions.byIds
  );
  const photos = source.append(layout.items);
  await source.ensureRange(0, 199);
  return { ...info, galleryOrder: true, photos, matchCount: photos.length };
}

export function subscribeAlbumRuleChanges(listener: () => void): () => void {
  const onMessage = (event: MessageEvent) => {
    if (
      event.source === window &&
      (event.data?.channel === "ai-tags-done" ||
        event.data?.channel === "ai-embedding-done")
    ) {
      listener();
    }
  };
  window.addEventListener("tags-changed", listener);
  window.addEventListener("message", onMessage);
  return () => {
    window.removeEventListener("tags-changed", listener);
    window.removeEventListener("message", onMessage);
  };
}
