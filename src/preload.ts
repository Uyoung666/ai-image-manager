import { ipcRenderer } from "electron";
import { IPC_CHANNELS } from "./constants";

window.addEventListener("message", (event) => {
  if (event.data === IPC_CHANNELS.START_ORPC_SERVER) {
    const [serverPort] = event.ports;

    ipcRenderer.postMessage(IPC_CHANNELS.START_ORPC_SERVER, null, [serverPort]);
  }
});

// Forward global shortcut events from main process to renderer
ipcRenderer.on("global-shortcut:search", () => {
  window.postMessage("global-shortcut:search", "*");
});
