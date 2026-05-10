import { ipc } from "@/ipc/manager";

export function getPlatform(): Promise<string> {
  return ipc.client.app.currentPlatform();
}

export function getAppVersion(): Promise<string> {
  return ipc.client.app.appVersion();
}
