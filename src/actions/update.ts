import { ipc } from "@/ipc/manager";

export function getUpdateStatus() {
  return ipc.client.app.getUpdateStatus({});
}

export function checkForUpdates() {
  return ipc.client.app.checkForUpdates({});
}

export function installDownloadedUpdate() {
  return ipc.client.app.installDownloadedUpdate({});
}

export function openReleasePage() {
  return ipc.client.app.openReleasePage({});
}
