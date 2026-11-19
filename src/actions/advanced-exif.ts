import { ipc } from "@/ipc/manager";

export const advancedExifActions = {
  getPhotoExif: (id: number) => ipc.client.photos.getPhotoExif({ id }),
  getStatus: () => ipc.client.photos.getAdvancedExifStatus(),
  pause: () => ipc.client.photos.pauseAdvancedExif(),
  resume: () => ipc.client.photos.resumeAdvancedExif(),
  retry: () => ipc.client.photos.retryAdvancedExif(),
  start: () => ipc.client.photos.startAdvancedExif(),
};

export function onAdvancedExifComplete(callback: () => void): () => void {
  const onMessage = (event: MessageEvent) => {
    if (
      event.source === window &&
      event.data?.type === "advanced-exif-progress" &&
      event.data.running === false &&
      event.data.processed > 0
    ) {
      callback();
    }
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}
