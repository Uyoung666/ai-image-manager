import { contextBridge, ipcRenderer, webUtils } from "electron";
import { IPC_CHANNELS } from "./constants";

console.log("[Preload] loaded, channel:", IPC_CHANNELS.START_ORPC_SERVER);

window.addEventListener("message", (event) => {
  console.log("[Preload] message event:", event.data, "ports:", event.ports?.length);
  if (event.data === IPC_CHANNELS.START_ORPC_SERVER) {
    const [serverPort] = event.ports;
    console.log("[Preload] forwarding port to main, port:", !!serverPort);
    ipcRenderer.postMessage(IPC_CHANNELS.START_ORPC_SERVER, null, [serverPort]);
  }
});

contextBridge.exposeInMainWorld("electronAPI", {
  getFilePath: (file: File): string => webUtils.getPathForFile(file),
  preloadReady: true,
});

ipcRenderer.on("global-shortcut:search", () => {
  window.postMessage("global-shortcut:search", "*");
});

ipcRenderer.on(IPC_CHANNELS.FILE_CHANGE, (_event, payload) => {
  window.postMessage({ channel: IPC_CHANNELS.FILE_CHANGE, ...payload }, "*");
});
