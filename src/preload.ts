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
  restartApp: (): void => {
    ipcRenderer.send("app:restart");
  },
  setLanguage: (lang: string): void => {
    ipcRenderer.send("app:language-changed", lang);
  },
  openExternal: (url: string): void => {
    ipcRenderer.send("shell:open-external", url);
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

ipcRenderer.on("ai-embedding-done", () => {
  window.postMessage({ channel: "ai-embedding-done" }, "*");
});

ipcRenderer.on("ai-progress", (_event, payload) => {
  window.postMessage({ channel: "ai-progress", ...payload }, "*");
});

ipcRenderer.on("theme:system-changed", (_event, resolved) => {
  window.postMessage({ channel: "theme:system-changed", resolved }, "*");
});

ipcRenderer.on("data-path-migrate-progress", (_event, payload) => {
  window.postMessage(
    { channel: "data-path-migrate-progress", ...payload },
    "*"
  );
});

ipcRenderer.on("update:available", (_event, info) => {
  window.postMessage({ channel: "update:available", ...info }, "*");
});

ipcRenderer.on("update:status", (_event, payload) => {
  window.postMessage({ channel: "update:status", ...payload }, "*");
});
