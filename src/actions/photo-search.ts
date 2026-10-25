import { ipc } from "@/ipc/manager";

/** Preserve the typed response, including time-filter metadata on empty pages. */
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
