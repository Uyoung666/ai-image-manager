import { contextBridge, ipcRenderer, webUtils } from "electron";
import { IPC_CHANNELS, type WanderLifecycleState } from "./constants";

let latestWanderLifecycleState: WanderLifecycleState | null = null;

function postToRenderer(message: unknown): void {
  const targetOrigin = window.location.origin;
  window.postMessage(message, targetOrigin === "null" ? "*" : targetOrigin);
}

ipcRenderer.on(IPC_CHANNELS.WANDER_LIFECYCLE, (_event, payload) => {
  latestWanderLifecycleState = payload as WanderLifecycleState;
  postToRenderer(latestWanderLifecycleState);
});

window.addEventListener("message", (event) => {
  const currentOrigin = window.location.origin;
  const sameOrigin =
    event.origin === currentOrigin ||
    (window.location.protocol === "file:" && event.origin === "null");
  if (
    event.source !== window ||
    !sameOrigin ||
    event.data !== IPC_CHANNELS.START_ORPC_SERVER ||
    event.ports.length !== 1
  ) {
    return;
  }

  const [serverPort] = event.ports;
  if (
    !serverPort ||
    typeof serverPort.start !== "function" ||
    typeof serverPort.postMessage !== "function"
  ) {
    return;
  }

  ipcRenderer.postMessage(IPC_CHANNELS.START_ORPC_SERVER, null, [serverPort]);
});

// 从 additionalArguments 读取主进程传入的 HTTP 端口号
// 这使得渲染进程可以同步获取端口，无需等待异步 IPC
const httpPortArg = process.argv.find((a) => a.startsWith("--http-port="));
const httpPort = httpPortArg
  ? Number.parseInt(httpPortArg.split("=")[1], 10)
  : 0;
const httpTokenArg = process.argv.find((a) => a.startsWith("--http-token="));
const httpAuthToken = httpTokenArg
  ? httpTokenArg.slice("--http-token=".length)
  : "";

// E2E 测试模式：跳过引导流程
const isE2E = process.argv.includes("--e2e");

contextBridge.exposeInMainWorld("electronAPI", {
  getFilePath: (file: File): string => webUtils.getPathForFile(file),
  isDirectoryPath: (filePath: string): boolean => {
    try {
      return (
        ipcRenderer.sendSync(IPC_CHANNELS.IS_DIRECTORY_PATH, filePath) === true
      );
    } catch {
      return false;
    }
  },
  preloadReady: true,
  // HTTP 服务器端口（由主进程在 createWindow 时通过 additionalArguments 注入）
  httpPort,
  httpAuthToken,
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
  postToRenderer("global-shortcut:search");
});

ipcRenderer.on(IPC_CHANNELS.FILE_CHANGE, (_event, payload) => {
  postToRenderer({ channel: IPC_CHANNELS.FILE_CHANGE, ...payload });
});

ipcRenderer.on("scan-progress", (_event, payload) => {
  postToRenderer({ channel: "scan-progress", ...payload });
});

ipcRenderer.on("ai-embedding-done", () => {
  postToRenderer({ channel: "ai-embedding-done" });
});

ipcRenderer.on("ai-progress", (_event, payload) => {
  postToRenderer({ channel: "ai-progress", ...payload });
});

ipcRenderer.on("ai-auto-repair-started", (_event, payload) => {
  postToRenderer({ channel: "ai-auto-repair-started", ...payload });
});

ipcRenderer.on("ai-status-changed", (_event, payload) => {
  postToRenderer({ channel: "ai-status-changed", ...payload });
});

ipcRenderer.on("sequences-changed", (_event, payload) => {
  postToRenderer({ channel: "sequences-changed", ...payload });
});

ipcRenderer.on("import-queue-status", (_event, payload) => {
  postToRenderer({ channel: "import-queue-status", ...payload });
});

ipcRenderer.on("theme:system-changed", (_event, resolved) => {
  postToRenderer({ channel: "theme:system-changed", resolved });
});

ipcRenderer.on("data-path-migrate-progress", (_event, payload) => {
  postToRenderer({ channel: "data-path-migrate-progress", ...payload });
});

ipcRenderer.on("update:available", (_event, info) => {
  postToRenderer({ channel: "update:available", ...info });
});

ipcRenderer.on("update:status", (_event, payload) => {
  postToRenderer({ channel: "update:status", ...payload });
});

// GPU prompt events removed — GPU detection is now integrated into
// the Onboarding overlay flow (step 2), not a standalone popup.

ipcRenderer.on("face-detection-progress", (_event, payload) => {
  postToRenderer({ channel: "face-detection-progress", ...payload });
});

ipcRenderer.on("face-detection-done", (_event, payload) => {
  postToRenderer({ channel: "face-detection-done", ...payload });
});

ipcRenderer.on("window:maximize-change", (_event, isMaximized: boolean) => {
  postToRenderer({ channel: "window:maximize-change", isMaximized });
});
