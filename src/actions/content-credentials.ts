import { ipc } from "@/ipc/manager";

export const contentCredentialActions = {
  available: () => ipc.client.photos.contentCredentialAvailable(),
  current: (id: number, stamp: string) =>
    ipc.client.photos.contentCredentialCurrent({ id, stamp }),
  saved: (id: number) => ipc.client.photos.savedContentCredential({ id }),
  verify: (id: number) => ipc.client.photos.verifyContentCredential({ id }),
};
