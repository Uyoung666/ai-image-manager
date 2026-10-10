import { ipc } from "@/ipc/manager";

export const aiActions = {
  getProgress: () => ipc.client.photos.getAiProgress({}),
  getStatus: () => ipc.client.photos.getAiStatus({ loadModel: false }),
  start: () => ipc.client.photos.startAiIndexing({}),
  pause: () => ipc.client.photos.pauseAiIndexing({}),
  resume: () => ipc.client.photos.resumeAiIndexing({}),
  cancel: () => ipc.client.photos.cancelAiIndexing({}),
};

/** Only an explicit rebuild request resets vectors; a failed reset never starts indexing. */
export async function rebuildAiIndex() {
  const reset = await ipc.client.photos.resetAiIndex({});
  if (!reset.success) {
    return {
      success: false,
      busy: "busy" in reset && reset.busy === true,
      error: "error" in reset ? reset.error : undefined,
    };
  }
  const start = await aiActions.start();
  return {
    success: start.started,
    busy: "busy" in start && start.busy === true,
    error: undefined,
  };
}
