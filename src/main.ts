import fs from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  globalShortcut,
  Menu,
  type NativeImage,
  nativeImage,
  protocol,
  Tray,
} from "electron";
import { ipcMain } from "electron/main";
import Store from "electron-store";
import { UpdateSourceType, updateElectronApp } from "update-electron-app";
import { initDatabase } from "@/db";
import { ipcContext } from "@/ipc/context";
import { startWatching } from "@/services/indexer";
import { initThumbnailer } from "@/services/thumbnailer";
import { IPC_CHANNELS, inDevelopment } from "./constants";
import { getBasePath } from "./utils/path";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

const windowStore = new Store<{
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  isMaximized?: boolean;
}>({
  name: "window-state",
  defaults: { width: 1280, height: 800 },
});

function createTrayIcon(): NativeImage {
  // Generate a 16x16 tray icon programmatically (simple square with accent color)
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inCircle = (x - 7) ** 2 + (y - 7) ** 2 < 36;
      canvas[i] = 0x5e; // R
      canvas[i + 1] = 0x6a; // G
      canvas[i + 2] = 0xd2; // B
      canvas[i + 3] = inCircle ? 255 : 0; // A
    }
  }
  return nativeImage.createFromBuffer(canvas, { width: size, height: size });
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip("AI Image Manager");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "显示窗口",
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: "separator" },
    {
      label: "开机自启",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (menuItem) => {
        app.setLoginItemSettings({ openAtLogin: menuItem.checked });
      },
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        app.exit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on("double-click", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function registerGlobalShortcuts() {
  const registered = globalShortcut.register("Ctrl+Shift+F", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send("global-shortcut:search");
    }
  });

  if (!registered) {
    console.warn("[App] Failed to register global shortcut Ctrl+Shift+F");
  }
}

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

  mainWindow = new BrowserWindow({
    width: savedWidth,
    height: savedHeight,
    minWidth: 720,
    minHeight: 480,
    ...(savedX !== undefined && savedY !== undefined
      ? { x: savedX, y: savedY }
      : {}),
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

  // Minimize to tray instead of closing (Windows)
  mainWindow.on("close", (event) => {
    if (tray && process.platform === "win32") {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  // Save window state on move/resize
  const saveBounds = () => {
    if (mainWindow?.isMaximized()) {
      windowStore.set("isMaximized", true);
    } else {
      windowStore.set("isMaximized", false);
      const bounds = mainWindow?.getBounds();
      if (bounds) {
        windowStore.set({
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        });
      }
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
    createTray();
    registerGlobalShortcuts();
    checkForUpdates();
    await setupORPC();
  } catch (error) {
    console.error("Error during app initialization:", error);
  }
});

// Don't quit when all windows are closed (tray keeps app alive)
app.on("window-all-closed", () => {
  // On macOS, keep app alive (standard behavior)
  // On Windows/Linux, tray keeps it alive
});

app.on("activate", () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (tray) {
    tray.destroy();
    tray = null;
  }
});
