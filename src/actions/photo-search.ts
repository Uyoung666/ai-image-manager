import { ipc } from "@/ipc/manager";

/** Both initial searches and EXIF continuation use the same typed IPC contract. */
export function searchPhotos(
  params: Parameters<typeof ipc.client.photos.searchCompound>[0]
) {
  return ipc.client.photos.searchCompound(params);
}
