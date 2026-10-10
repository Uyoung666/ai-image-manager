import { ipc } from "@/ipc/manager";
import type { Photo } from "@/types/photo";

export interface AlbumDetail {
  coverPhotoId: number | null;
  description: string | null;
  id: number;
  isSmart?: boolean;
  matchCount?: number;
  name: string;
  photos: Photo[];
}

export async function getAlbum(id: number): Promise<AlbumDetail> {
  return (await ipc.client.albums.getAlbum({ id })) as unknown as AlbumDetail;
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
