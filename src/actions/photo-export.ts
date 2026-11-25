import { ipc } from "@/ipc/manager";
export const photoExportActions = {
  choosePath: (input: Parameters<typeof ipc.client.shell.saveFileDialog>[0]) =>
    ipc.client.shell.saveFileDialog(input),
  export: (input: Parameters<typeof ipc.client.photos.exportPhotos>[0]) =>
    ipc.client.photos.exportPhotos(input),
  getWatermarkSettings: () => ipc.client.photos.getWatermarkSettings({}),
  openFolder: (path: string) => ipc.client.shell.openInExplorer({ path }),
};
