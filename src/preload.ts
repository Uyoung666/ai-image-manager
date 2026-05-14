import { contextBridge, ipcRenderer, webUtils } from "electron";
import { IPC_CHANNELS } from "./constants";

window.addEventListener("message", (event) => {
  if (event.data === IPC_CHANNELS.START_ORPC_SERVER) {
    const [serverPort] = event.ports;
    ipcRenderer.postMessage(IPC_CHANNELS.START_ORPC_SERVER, null, [serverPort]);
  }
});

contextBridge.exposeInMainWorld("electronAPI", {
  getFilePath: (file: File): string => webUtils.getPathForFile(file),
  preloadReady: true,
  startDrag: (filePath: string): void => {
    ipcRenderer.send(IPC_CHANNELS.NATIVE_FILE_DRAG, filePath);
  },
});

ipcRenderer.on("global-shortcut:search", () => {
  window.postMessage("global-shortcut:search", "*");
});

ipcRenderer.on(IPC_CHANNELS.FILE_CHANGE, (_event, payload) => {
  window.postMessage({ channel: IPC_CHANNELS.FILE_CHANGE, ...payload }, "*");
});

ipcRenderer.on("scan-progress", (_event, payload) => {
  window.postMessage({ channel: "scan-progress", ...payload }, "*");
});
