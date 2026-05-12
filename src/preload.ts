import { contextBridge, ipcRenderer, webUtils } from "electron";
import { IPC_CHANNELS } from "./constants";

window.addEventListener("message", (event) => {
  if (event.data === IPC_CHANNELS.START_ORPC_SERVER) {
    const [serverPort] = event.ports;

    ipcRenderer.postMessage(IPC_CHANNELS.START_ORPC_SERVER, null, [serverPort]);
  }
});

ipcRenderer.on("global-shortcut:search", () => {
  window.postMessage("global-shortcut:search", "*");
});

ipcRenderer.on(IPC_CHANNELS.FILE_CHANGE, (_event, payload) => {
  window.postMessage({ channel: IPC_CHANNELS.FILE_CHANGE, ...payload }, "*");
});

// Expose getPathForFile via contextBridge (contextIsolation requires this)
contextBridge.exposeInMainWorld("electronAPI", {
  getFilePath: (file: File): string => webUtils.getPathForFile(file),
});
