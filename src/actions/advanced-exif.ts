import { ipc } from "@/ipc/manager";

export const advancedExifActions = {
  getStatus: () => ipc.client.photos.getAdvancedExifStatus(),
  pause: () => ipc.client.photos.pauseAdvancedExif(),
  resume: () => ipc.client.photos.resumeAdvancedExif(),
  retry: () => ipc.client.photos.retryAdvancedExif(),
  start: () => ipc.client.photos.startAdvancedExif(),
};
