import { contextBridge, ipcRenderer, webUtils } from "electron";
import { IPC_CHANNELS, type WanderLifecycleState } from "./constants";

let latestWanderLifecycleState: WanderLifecycleState | null = null;

ipcRenderer.on(IPC_CHANNELS.WANDER_LIFECYCLE, (_event, payload) => {
  latestWanderLifecycleState = payload as WanderLifecycleState;
  window.postMessage(latestWanderLifecycleState, "*");
});

window.addEventListener("message", (event) => {
  if (event.data === IPC_CHANNELS.START_ORPC_SERVER) {
    const [serverPort] = event.ports;
    ipcRenderer.postMessage(IPC_CHANNELS.START_ORPC_SERVER, null, [serverPort]);
  }
});

// 从 additionalArguments 读取主进程传入的 HTTP 端口号
// 这使得渲染进程可以同步获取端口，无需等待异步 IPC
const httpPortArg = process.argv.find((a) => a.startsWith("--http-port="));
const httpPort = httpPortArg
  ? Number.parseInt(httpPortArg.split("=")[1], 10)
  : 0;

// E2E 测试模式：跳过引导流程
const isE2E = process.argv.includes("--e2e");

contextBridge.exposeInMainWorld("electronAPI", {
  getFilePath: (file: File): string => webUtils.getPathForFile(file),
  preloadReady: true,
  // HTTP 服务器端口（由主进程在 createWindow 时通过 additionalArguments 注入）
  httpPort,
  // E2E 测试模式
  isE2E,
  getWanderLifecycleState: (): WanderLifecycleState | null =>
    latestWanderLifecycleState,
  startDrag: (filePath: string): void => {
    ipcRenderer.send(IPC_CHANNELS.NATIVE_FILE_DRAG, filePath);
  },
  copyImageToClipboard: (filePath: string): Promise<boolean> => {
    return ipcRenderer.invoke("clipboard:copy-image", filePath);
  },
  restartApp: (): void => {
    ipcRenderer.send("app:restart");
  },
  installUpdate: (): void => {
    ipcRenderer.send("app:install-update");
  },
  setLanguage: (lang: string): void => {
    ipcRenderer.send("app:language-changed", lang);
  },
  openExternal: (url: string): void => {
    ipcRenderer.send("shell:open-external", url);
  },
  // 应用级 IPC 接口
  app: {
    getHttpPort: (): Promise<number | null> => {
      return ipcRenderer.invoke("app:get-http-port");
    },
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

ipcRenderer.on("ai-auto-repair-started", (_event, payload) => {
  window.postMessage({ channel: "ai-auto-repair-started", ...payload }, "*");
});

ipcRenderer.on("ai-status-changed", (_event, payload) => {
  window.postMessage({ channel: "ai-status-changed", ...payload }, "*");
});

ipcRenderer.on("sequences-changed", (_event, payload) => {
  window.postMessage({ channel: "sequences-changed", ...payload }, "*");
});

ipcRenderer.on("import-queue-status", (_event, payload) => {
  window.postMessage({ channel: "import-queue-status", ...payload }, "*");
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

// GPU prompt events removed — GPU detection is now integrated into
// the Onboarding overlay flow (step 2), not a standalone popup.

ipcRenderer.on("face-detection-progress", (_event, payload) => {
  window.postMessage({ channel: "face-detection-progress", ...payload }, "*");
});

ipcRenderer.on("face-detection-done", (_event, payload) => {
  window.postMessage({ channel: "face-detection-done", ...payload }, "*");
});

ipcRenderer.on("window:maximize-change", (_event, isMaximized: boolean) => {
  window.postMessage({ channel: "window:maximize-change", isMaximized }, "*");
});
