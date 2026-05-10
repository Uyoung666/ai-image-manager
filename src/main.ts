import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, protocol } from "electron";
import { ipcMain } from "electron/main";
import { UpdateSourceType, updateElectronApp } from "update-electron-app";
import Store from "electron-store";
import { ipcContext } from "@/ipc/context";
import { IPC_CHANNELS, inDevelopment } from "./constants";
import { getBasePath } from "./utils/path";
import { initDatabase } from "@/db";
import { initThumbnailer } from "@/services/thumbnailer";
import { startWatching } from "@/services/indexer";

const windowStore = new Store<{ x?: number; y?: number; width?: number; height?: number; isMaximized?: boolean }>({
  name: "window-state",
  defaults: { width: 1280, height: 800 },
});

function getMimeType(ext: string): string {
  const mimeTypes: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
    ".tiff": "image/tiff",
    ".tif": "image/tiff",
    ".avif": "image/avif",
    ".heic": "image/heic",
    ".heif": "image/heif",
  };
  return mimeTypes[ext] ?? "image/jpeg";
}

function createWindow() {
  const basePath = getBasePath();
  const preload = path.join(basePath, "preload.js");

  const savedWidth = windowStore.get("width", 1280);
  const savedHeight = windowStore.get("height", 800);
  const savedX = windowStore.get("x");
  const savedY = windowStore.get("y");

  const mainWindow = new BrowserWindow({
    width: savedWidth,
    height: savedHeight,
    minWidth: 900,
    minHeight: 600,
    ...(savedX !== undefined && savedY !== undefined ? { x: savedX, y: savedY } : {}),
    title: "AI Image Manager",
    webPreferences: {
      devTools: inDevelopment,
      contextIsolation: true,
      nodeIntegration: false,
      preload,
    },
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    trafficLightPosition:
      process.platform === "darwin" ? { x: 5, y: 5 } : undefined,
  });

  if (windowStore.get("isMaximized", false)) {
    mainWindow.maximize();
  }

  // Save window state on move/resize
  const saveBounds = () => {
    if (mainWindow.isMaximized()) {
      windowStore.set("isMaximized", true);
    } else {
      windowStore.set("isMaximized", false);
      const bounds = mainWindow.getBounds();
      windowStore.set({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
    }
  };

  mainWindow.on("resize", saveBounds);
  mainWindow.on("move", saveBounds);
  mainWindow.on("maximize", () => windowStore.set("isMaximized", true));
  mainWindow.on("unmaximize", () => windowStore.set("isMaximized", false));

  ipcContext.setMainWindow(mainWindow);

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(basePath, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
    );
  }
}

function checkForUpdates() {
  updateElectronApp({
    updateSource: {
      type: UpdateSourceType.ElectronPublicUpdateService,
      repo: "uyoung/ai-image-manager",
    },
  });
}

async function setupORPC() {
  const { rpcHandler } = await import("./ipc/handler");

  ipcMain.on(IPC_CHANNELS.START_ORPC_SERVER, (event) => {
    const [serverPort] = event.ports;

    serverPort.start();
    rpcHandler.upgrade(serverPort);
  });
}

// Custom protocol must be registered as privileged before app.whenReady()
// Otherwise Chromium blocks cross-origin requests to custom schemes
protocol.registerSchemesAsPrivileged([
  {
    scheme: "local-media",
    privileges: {
      supportFetchAPI: true,
      bypassCSP: true,
      corsEnabled: false,
      stream: true,
    },
  },
]);

app.whenReady().then(async () => {
  try {
    // Register custom protocol handler for local file access
    // (Chromium blocks file:// from http:// origins in dev mode)
    protocol.handle("local-media", async (request) => {
      try {
        const encodedPath = request.url.slice("local-media://".length);
        const filePath = decodeURIComponent(encodedPath);
        const ext = path.extname(filePath).toLowerCase();
        const buffer = await fs.promises.readFile(filePath);
        return new Response(buffer, {
          headers: {
            "content-type": getMimeType(ext),
            "cache-control": "public, max-age=31536000, immutable",
          },
        });
      } catch {
        return new Response(null, { status: 404 });
      }
    });

    initDatabase();
    initThumbnailer();
    console.log("[App] Database and thumbnailer initialized");

    startWatching((photoId, event) => {
      console.log(`[Watcher] File ${event}: photoId=${photoId}`);
    });

    createWindow();
    checkForUpdates();
    await setupORPC();
  } catch (error) {
    console.error("Error during app initialization:", error);
  }
});

//osX only
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
//osX only ends
