import { ipc } from "@/ipc/manager";

/** Both initial searches and EXIF continuation use the same typed IPC contract. */
export async function searchPhotos(
  params: Parameters<typeof ipc.client.photos.searchCompound>[0]
) {
  const started = performance.now();
  const response = await ipc.client.photos.searchCompound({
    ...params,
    requestId: params.requestId ?? crypto.randomUUID(),
  });
  if (response.diagnostics) {
    response.diagnostics.timings.ipcMs = performance.now() - started;
  }
  return response;
}

export function cancelPhotoSearch(requestId: string) {
  return ipc.client.photos.cancelSearch({ requestId });
}
