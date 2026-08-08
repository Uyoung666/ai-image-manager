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

export function getUpdateProxy() {
  return ipc.client.app.getUpdateProxy({});
}

export function setUpdateProxy(proxy: string) {
  return ipc.client.app.setUpdateProxy({ proxy });
}

export function testUpdateProxy() {
  return ipc.client.app.testProxy({});
}

export function openReleasePage() {
  return ipc.client.app.openReleasePage({});
}
