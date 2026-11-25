import { ipc } from "@/ipc/manager";

export const photoShareActions = {
  listCloudConfigs: () => ipc.client.cloud.listCloudConfigs({}),
  publish: (
    input: Parameters<typeof ipc.client.photos.generateAndUploadShare>[0]
  ) => ipc.client.photos.generateAndUploadShare(input),
};
