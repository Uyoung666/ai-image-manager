import { ipc } from "@/ipc/manager";
import type { UpdateResult, UpdateStatus } from "@/types/update";

export function getUpdateStatus(): Promise<UpdateStatus> {
  return ipc.client.app.getUpdateStatus({});
}

export function checkForUpdates(): Promise<UpdateResult> {
  return ipc.client.app.checkForUpdates({});
}

export function installDownloadedUpdate(): Promise<UpdateResult> {
  return ipc.client.app.installDownloadedUpdate({});
}

export function openReleasePage() {
  return ipc.client.app.openReleasePage({});
}
