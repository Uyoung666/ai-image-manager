import { ipc } from "@/ipc/manager";
import type { UpdateResult, UpdateStatus } from "@/types/update";

export function getUpdateStartupContext() {
  return ipc.client.app.getUpdateStartupContext({});
}
export function reportUpdateStartup(nonce: string, ready: boolean) {
  return ipc.client.app.reportUpdateStartup({ nonce, ready });
}
export function recheckInstaller(): Promise<UpdateResult> {
  return ipc.client.app.recheckInstaller({});
}
export async function restartForUpdate(): Promise<UpdateResult> {
  await ipc.client.app.restartApp({});
  return { ok: true };
}

export function getUpdateStatus(): Promise<UpdateStatus> {
  return ipc.client.app.getUpdateStatus({});
}

/** Explicit user retry, including after changing networks during a cooldown. */
export function checkForUpdates(): Promise<UpdateResult> {
  return ipc.client.app.checkForUpdates({});
}

export function installDownloadedUpdate(): Promise<UpdateResult> {
  return ipc.client.app.installDownloadedUpdate({});
}

export function openReleasePage() {
  return ipc.client.app.openReleasePage({});
}

export function resumeUpdate(): Promise<UpdateResult> {
  return ipc.client.app.resumeUpdate({});
}

export function downloadFullUpdate(): Promise<UpdateResult> {
  return ipc.client.app.downloadFullUpdate({});
}
