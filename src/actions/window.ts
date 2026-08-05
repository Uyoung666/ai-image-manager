import { ipc } from "../ipc/manager";

export async function minimizeWindow() {
  await ipc.client.window.minimizeWindow();
}
export async function maximizeWindow() {
  await ipc.client.window.maximizeWindow();
}
export async function closeWindow() {
  await ipc.client.window.closeWindow();
}
export async function getIsMaximized() {
  return await ipc.client.window.isWindowMaximized();
}
export async function setZoomFactor(scale: number) {
  await ipc.client.window.setZoomFactor({ scale });
}
