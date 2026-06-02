import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  app,
  autoUpdater,
  BrowserWindow,
  dialog,
  globalShortcut,
  Menu,
  nativeImage,
  nativeTheme,
  protocol,
  screen,
  Tray,
} from "electron";
import { ipcMain } from "electron/main";
import started from "electron-squirrel-startup";
import Store from "electron-store";
import sharp from "sharp";
import { UpdateSourceType, updateElectronApp } from "update-electron-app";
import { getDatabase } from "@/db";
import { appSettings, exifData, folders, photos, photoTags } from "@/db/schema";
import { ipcContext } from "@/ipc/context";
import { deletePhotoVectors, initVectorDB } from "@/services/ai-embedder";
import { extractRawPreview, isRawFile } from "@/services/raw-preview";
import { registry, ServiceLevel } from "@/services/registry";
import {
  getSendToFilePaths,
  setupSendToShortcut,
} from "@/services/sendto-integration";
import { getDataPath, initDataPath } from "@/utils/data-path";
import { IPC_CHANNELS, inDevelopment } from "./constants";
import { createLogger } from "./utils/logger.js";
import { getBasePath } from "./utils/path";
import { isSafePath } from "./utils/path-security.js";

const log = createLogger("main");

// ── Squirrel startup event handling ──────────────────────────────────
if (started) {
  app.quit();
}

// ── Single instance lock ─────────────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

// ── Fatal error handlers ─────────────────────────────────────────────
// MUST be registered before ANY fs operation so that crashes during
// initDataPath, logDir creation, or electron-store loading are caught.
let logDir: string | null = null;

function crashLog(message: string) {
  if (logDir) {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(path.join(logDir, "crash.log"), `${message}\n`, {
        flag: "a",
      });
    } catch {
      /* best-effort — if we can't write, at least show the dialog */
    }
  }
}

process.on("uncaughtException", (err) => {
  const message = String(err);
  const detail = err?.stack ?? message;
  crashLog(`UNCAUGHT ${message}\n${detail}`);
  try {
    log.fatal({ err }, "FATAL - uncaught exception");
  } catch (logErr) {
    crashLog(`LOGGER FAILED ${String(logErr)}`);
  }
  dialog.showErrorBox("Fatal Error", message);
  app.quit();
});

process.on("unhandledRejection", (reason) => {
  const message = String(reason);
  const detail = reason instanceof Error ? (reason.stack ?? message) : message;
  crashLog(`REJECTION ${detail}`);
  try {
    log.fatal({ reason }, "FATAL - unhandled rejection");
  } catch (logErr) {
    crashLog(`LOGGER FAILED ${String(logErr)}`);
  }
  dialog.showErrorBox("Fatal Error", message);
  app.quit();
});

// ── Log directory (scoped to app userData, not AppData root) ─────────
logDir = path.join(app.getPath("userData"), "logs");
fs.mkdirSync(logDir, { recursive: true });
fs.writeFileSync(
  path.join(logDir, "startup.log"),
  `STARTUP ${new Date().toISOString()} argv=${JSON.stringify(process.argv)}\n`,
  { flag: "a" }
);

function appendStartupLog(filename: string, message: string) {
  if (!logDir) {
    return;
  }
  try {
    fs.writeFileSync(path.join(logDir, filename), `${message}\n`, {
      flag: "a",
    });
  } catch {
    /* best-effort */
  }
}

function logMain(message: string) {
  appendStartupLog("main.log", `${new Date().toISOString()} ${message}`);
}

function summarizePathState(label: string, targetPath: string): string {
  try {
    const exists = fs.existsSync(targetPath);
    if (!exists) {
      return `${label}: MISSING ${targetPath}`;
    }
    const stats = fs.statSync(targetPath);
    const kind = stats.isDirectory() ? "dir" : "file";
    return `${label}: OK ${kind} ${targetPath}`;
  } catch (error) {
    return `${label}: ERROR ${targetPath} :: ${(error as Error).message}`;
  }
}

function logPackagedPathDiagnostics() {
  const appPath = app.getAppPath();
  const diagnostics = [
    `[Diag] isPackaged=${String(app.isPackaged)}`,
    `[Diag] process.execPath=${process.execPath}`,
    `[Diag] app.getPath(userData)=${app.getPath("userData")}`,
    `[Diag] app.getAppPath()=${appPath}`,
    `[Diag] process.resourcesPath=${process.resourcesPath}`,
    summarizePathState(
      "app-exe",
      path.join(path.dirname(appPath), "ai-image-manager.exe")
    ),
    summarizePathState("resources-dir", process.resourcesPath),
    summarizePathState(
      "app.asar",
      path.join(process.resourcesPath, "app.asar")
    ),
    summarizePathState(
      "asar-unpacked-transformers",
      path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "node_modules",
        "@xenova",
        "transformers",
        "package.json"
      )
    ),
    summarizePathState(
      "asar-unpacked-embed-worker",
      path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "scripts",
        "embed-worker.mjs"
      )
    ),
    summarizePathState(
      "asar-unpacked-face-worker",
      path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "scripts",
        "face-worker.mjs"
      )
    ),
    summarizePathState(
      "resource-model",
      path.join(
        process.resourcesPath,
        "models",
        "Xenova",
        "clip-vit-base-patch32",
        "onnx",
        "model_quantized.onnx"
      )
    ),
    summarizePathState(
      "cached-model",
      path.join(
        getDataPath(),
        "models",
        "Xenova",
        "clip-vit-base-patch32",
        "onnx",
        "model_quantized.onnx"
      )
    ),
  ];

  for (const line of diagnostics) {
    log.info(line);
    appendStartupLog("startup.log", line);
    appendStartupLog("whenReady.log", line);
  }
}

// ── Window & tray references ─────────────────────────────────────────
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
// True once before-quit fires — distinguishes "user clicked close" (hide to
// tray) from "app actually quitting" (e.g. relaunch, tray menu Exit, OS
// shutdown). Without this flag, every close is intercepted and app.quit()
// becomes a no-op, breaking app.relaunch() and similar flows.
let isQuitting = false;

// ── Window state store (lazy init) ───────────────────────────────────
let windowStore: Store<{
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  isMaximized?: boolean;
}>;

function getWindowStore() {
  if (!windowStore) {
    windowStore = new Store<{
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      isMaximized?: boolean;
    }>({
      name: "window-state",
      defaults: { width: 1280, height: 800 },
    });
  }
  return windowStore;
}

// ── Tray icon ────────────────────────────────────────────────────────
function getIconPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "icon.png");
  }
  return path.join(app.getAppPath(), "assets", "icon.png");
}

function createTray() {
  const iconPath = getIconPath();
  if (fs.existsSync(iconPath)) {
    const img = nativeImage.createFromPath(iconPath);
    tray = new Tray(img.resize({ width: 16, height: 16 }));
  } else {
    tray = new Tray(nativeImage.createEmpty());
  }
  tray.setToolTip("AI Image Manager");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show Window",
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: "separator" },
    {
      label: "Launch at Startup",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (menuItem) => {
        app.setLoginItemSettings({ openAtLogin: menuItem.checked });
      },
    },
    { type: "separator" },
    {
      label: "Quit",
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

// ── Global shortcuts ─────────────────────────────────────────────────
function registerGlobalShortcuts() {
  const searchRegistered = globalShortcut.register("Ctrl+Shift+F", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send("global-shortcut:search");
    }
  });
  if (!searchRegistered) {
    log.warn("Failed to register global shortcut Ctrl+Shift+F");
  }

  const hideRegistered = globalShortcut.register("Ctrl+Shift+H", () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
    }
  });
  if (!hideRegistered) {
    log.warn("Failed to register global shortcut Ctrl+Shift+H");
  }

  log.info(
    "Global shortcuts registered: Ctrl+Shift+F (search), Ctrl+Shift+H (hide)"
  );
}

// ── MIME type mapping ────────────────────────────────────────────────
function getMimeType(ext: string): string {
  const mimeTypes: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
    ".avif": "image/avif",
    ".tiff": "image/tiff",
    ".tif": "image/tiff",
    ".heic": "image/heic",
    ".heif": "image/heif",
    // RAW camera formats
    ".cr2": "image/x-canon-cr2",
    ".cr3": "image/x-canon-cr3",
    ".nef": "image/x-nikon-nef",
    ".nrw": "image/x-nikon-nrw",
    ".arw": "image/x-sony-arw",
    ".srf": "image/x-sony-srf",
    ".sr2": "image/x-sony-sr2",
    ".dng": "image/x-adobe-dng",
    ".orf": "image/x-olympus-orf",
    ".rw2": "image/x-panasonic-rw2",
    ".raf": "image/x-fujifilm-raf",
    ".pef": "image/x-pentax-pef",
    ".rwl": "image/x-leica-rwl",
    ".3fr": "image/x-hasselblad-3fr",
    ".raw": "image/x-raw",
  };
  return mimeTypes[ext] ?? "image/jpeg";
}

// ── AI model availability (copy from resources or dev paths) ─────────
async function ensureModelAvailable(): Promise<void> {
  const dataPath = getDataPath();
  const modelMarker = path.join(
    dataPath,
    "models",
    "Xenova",
    "clip-vit-base-patch32",
    "onnx",
    "model_quantized.onnx"
  );

  if (fs.existsSync(modelMarker)) {
    log.info("AI model already cached");
    return;
  }

  const resourceRoots = new Set<string>([
    process.resourcesPath,
    path.dirname(fileURLToPath(import.meta.url)),
  ]);

  for (const resourceRoot of resourceRoots) {
    const resourcesModel = path.join(
      resourceRoot,
      "models",
      "Xenova",
      "clip-vit-base-patch32",
      "onnx",
      "model_quantized.onnx"
    );

    if (!fs.existsSync(resourcesModel)) {
      continue;
    }

    log.info(
      { source: path.join(resourceRoot, "models") },
      "Copying model from resources"
    );
    await fs.promises.cp(
      path.join(resourceRoot, "models"),
      path.join(dataPath, "models"),
      {
        recursive: true,
      }
    );
    log.info("Model copied");
    return;
  }

  if (!app.isPackaged) {
    const devCandidates = [
      path.join(process.cwd(), "models"),
      path.join(app.getAppPath(), "models"),
      path.join(app.getAppPath(), "..", "models"),
      path.join(app.getAppPath(), "..", "..", "models"),
    ];

    for (const candidate of devCandidates) {
      const marker = path.join(
        candidate,
        "Xenova",
        "clip-vit-base-patch32",
        "onnx",
        "model_quantized.onnx"
      );
      log.debug({ marker }, "Checking for model");
      if (fs.existsSync(marker)) {
        log.info({ source: candidate }, "Copying model from dev path");
        await fs.promises.cp(candidate, path.join(dataPath, "models"), {
          recursive: true,
        });
        log.info("Model copied");
        return;
      }
    }
    log.warn("Model not found in dev paths, will rely on download");
  }
}

// ── Create main window ───────────────────────────────────────────────
function createWindow() {
  const basePath = getBasePath();
  const preload = path.join(basePath, "preload.js");

  const store = getWindowStore();
  const savedWidth = store.get("width", 1280);
  const savedHeight = store.get("height", 800);
  const savedX = store.get("x");
  const savedY = store.get("y");

  mainWindow = new BrowserWindow({
    width: savedWidth,
    height: savedHeight,
    minWidth: 720,
    minHeight: 480,
    ...(savedX !== undefined && savedY !== undefined
      ? { x: savedX, y: savedY }
      : {}),
    title: "AI Image Manager",
    icon: app.isPackaged
      ? path.join(process.resourcesPath, "icon.png")
      : path.join(app.getAppPath(), "assets", "icon.png"),
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

  if (store.get("isMaximized", false)) {
    mainWindow.maximize();
  }

  mainWindow.on("close", (event) => {
    // Hide to tray on user close, but allow real quits (relaunch, tray Exit,
    // OS shutdown) to proceed. Without the isQuitting guard, every close is
    // swallowed and app.quit()/app.relaunch() become no-ops.
    if (!isQuitting && tray && process.platform === "win32") {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  const saveBounds = () => {
    if (mainWindow?.isMaximized()) {
      store.set("isMaximized", true);
    } else {
      store.set("isMaximized", false);
      const bounds = mainWindow?.getBounds();
      if (bounds) {
        store.set({
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
  mainWindow.on("maximize", () => store.set("isMaximized", true));
  mainWindow.on("unmaximize", () => store.set("isMaximized", false));
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  ipcContext.setMainWindow(mainWindow);

  // typeof guard: prevents ReferenceError in production strict mode
  if (typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === "undefined") {
    mainWindow.loadFile(
      path.join(basePath, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
    );
  } else {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  }

  const display = screen.getDisplayMatching(mainWindow.getBounds());
  const bounds = display.workArea;
  if (
    mainWindow.getBounds().width < 720 ||
    mainWindow.getBounds().height < 480
  ) {
    mainWindow.setSize(
      Math.max(1280, bounds.width - 80),
      Math.max(800, bounds.height - 120)
    );
  }
}

// ── Auto-update state (persisted in main process so settings page can query on mount) ─
import { setUpdateState } from "@/services/update-state";

function broadcastUpdateStatus(payload: Record<string, unknown>) {
  setUpdateState({
    phase: payload.phase as string,
    version: payload.version as string | undefined,
    message: payload.message as string | undefined,
  });
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("update:status", payload);
  }
}

// ── Auto-update check ────────────────────────────────────────────────
function checkForUpdates() {
  updateElectronApp({
    updateSource: {
      type: UpdateSourceType.ElectronPublicUpdateService,
      repo: "Uyoung666/ai-image-manager",
    },
    notifyUser: true,
    onNotifyUser: (info) => {
      log.info(
        { version: info.releaseName, url: info.updateURL },
        "Update downloaded — notifying renderer"
      );
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("update:available", {
          version: info.releaseName,
          releaseDate: info.releaseDate,
          releaseNotes: info.releaseNotes,
        });
      }
      broadcastUpdateStatus({ phase: "downloaded", version: info.releaseName });
    },
    logger: {
      log: (msg) => log.info(`[updater] ${msg}`),
      info: (msg) => log.info(`[updater] ${msg}`),
      warn: (msg) => log.warn(`[updater] ${msg}`),
      error: (msg) => log.error(`[updater] ${msg}`),
    },
  });

  autoUpdater.on("checking-for-update", () => {
    broadcastUpdateStatus({ phase: "checking" });
  });

  autoUpdater.on("update-available", () => {
    broadcastUpdateStatus({ phase: "downloading" });
  });

  autoUpdater.on("update-not-available", () => {
    broadcastUpdateStatus({ phase: "up-to-date" });
  });

  autoUpdater.on("error", (err) => {
    broadcastUpdateStatus({
      phase: "error",
      message: err?.message || String(err),
    });
  });

  // download-progress: try to forward (Electron 41 types removed it, but Squirrel may still emit)
  try {
    (autoUpdater as any).on("download-progress", (progress: any) => {
      broadcastUpdateStatus({
        phase: "downloading",
        percent: Math.round(progress.percent || 0),
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
      });
    });
  } catch {
    /* download-progress not available */
  }

  log.info("Update checker started");
}

ipcMain.on("app:restart", () => {
  app.relaunch({
    args: process.argv.slice(1).concat(["--relaunch"]),
    execPath: process.execPath,
  });
  app.quit();
});

// ── IPC / oRPC setup ─────────────────────────────────────────────────
async function setupORPC() {
  const { rpcHandler } = await import("./ipc/handler");
  ipcMain.on(IPC_CHANNELS.START_ORPC_SERVER, (event) => {
    const [serverPort] = event.ports;
    rpcHandler.upgrade(serverPort);
    serverPort.start();
  });

  ipcMain.on(IPC_CHANNELS.NATIVE_FILE_DRAG, (event, filePath: string) => {
    if (!(filePath && fs.existsSync(filePath))) {
      return;
    }
    const icon = nativeImage.createFromPath(filePath).resize({
      width: 64,
      height: 64,
    });
    event.sender.startDrag({ file: filePath, icon });
  });
}

// ── Startup cleanup: orphan records + photoCount drift ───────────────
async function runStartupCleanup() {
  try {
    const db = getDatabase();
    const orphanIds = db
      .select({ id: photos.id })
      .from(photos)
      .where(
        sql`${photos.folderId} IS NULL OR ${photos.folderId} NOT IN (SELECT id FROM folders)`
      )
      .all()
      .map((p) => p.id);

    if (orphanIds.length > 0) {
      db.delete(exifData).where(inArray(exifData.photoId, orphanIds)).run();
      db.delete(photoTags).where(inArray(photoTags.photoId, orphanIds)).run();
      db.delete(photos).where(inArray(photos.id, orphanIds)).run();
      log.info(
        { count: orphanIds.length },
        "Startup cleanup: removed orphan photo records"
      );

      initVectorDB()
        .then(() => deletePhotoVectors(orphanIds))
        .catch(() => {
          /* best-effort */
        });
    }
  } catch (err) {
    log.warn({ err }, "Orphan cleanup skipped");
  }

  try {
    const db = getDatabase();
    const allFolders = db.select({ id: folders.id }).from(folders).all();
    for (const f of allFolders) {
      const count =
        db
          .select({ c: sql<number>`count(*)` })
          .from(photos)
          .where(
            and(sql`${photos.folderId} = ${f.id}`, isNull(photos.deletedAt))
          )
          .get()?.c ?? 0;
      db.update(folders)
        .set({ photoCount: count })
        .where(sql`${folders.id} = ${f.id}`)
        .run();
    }
  } catch (err) {
    log.warn({ err }, "photoCount recalculation skipped");
  }
}

// ── Bootstrap background services (non-blocking after window is shown) ──
async function startBackgroundServices() {
  try {
    logMain("[bg] startLevel(Critical) begin");
    await registry.startLevel(ServiceLevel.Critical);
    log.info("Critical services started");
    logMain("[bg] startLevel(Critical) done");

    await runStartupCleanup();
    logMain("[bg] runStartupCleanup done");

    await ensureModelAvailable();
    logMain("[bg] ensureModelAvailable done");

    await registry.startRemaining();
    log.info("All services started");
    logMain("[bg] startRemaining done");
  } catch (err) {
    const stack = (err as Error)?.stack || String(err);
    logMain(`[bg] FATAL ${stack}`);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// App initialization
// ═══════════════════════════════════════════════════════════════════════

// Custom protocol must be registered as privileged BEFORE app.whenReady()
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

fs.writeFileSync(path.join(logDir, "startup.log"), "BEFORE_WHENREADY\n", {
  flag: "a",
});

app.whenReady().then(async () => {
  fs.writeFileSync(
    path.join(logDir, "whenReady.log"),
    `WHENREADY ${new Date().toISOString()}\n`
  );

  logPackagedPathDiagnostics();

  try {
    // ── Step 1: Fast synchronous setup (no blocking I/O) ─────────────
    initDataPath();
    log.info({ dataPath: getDataPath() }, "Data path initialized");

    // Register custom protocol handler for local file access.
    // Must be set up before createWindow() since the window loads
    // local-media:// URLs immediately.
    protocol.handle("local-media", async (request) => {
      try {
        const encodedPath = request.url.slice("local-media://".length);
        const filePath = decodeURIComponent(encodedPath);
        const resolved = path.resolve(filePath);

        const db = getDatabase();
        const indexedFolders = db
          .select({ path: folders.path })
          .from(folders)
          .all();
        const allowedPaths = [
          getDataPath(),
          ...indexedFolders.map((f) => f.path),
        ];

        // 使用路径安全验证函数
        if (!isSafePath(resolved, allowedPaths)) {
          log.warn({ filePath }, "Security: local-media blocked");
          return new Response(null, { status: 403 });
        }

        if (!fs.existsSync(resolved)) {
          return new Response(null, { status: 404 });
        }

        const ext = path.extname(resolved).toLowerCase();
        const buffer = await fs.promises.readFile(resolved);

        // Chromium natively supports these image formats. For everything else
        // (TIFF, HEIC, RAW camera formats), convert to PNG on-the-fly via sharp.
        const browserCompatible = new Set([
          ".jpg",
          ".jpeg",
          ".png",
          ".gif",
          ".webp",
          ".bmp",
          ".ico",
          ".avif",
          ".svg",
        ]);

        if (browserCompatible.has(ext)) {
          return new Response(buffer, {
            headers: {
              "content-type": getMimeType(ext),
              "cache-control": "public, max-age=31536000, immutable",
            },
          });
        }

        // RAW camera formats: extract embedded JPEG preview
        if (isRawFile(resolved)) {
          const preview = await extractRawPreview(resolved);
          if (preview) {
            return new Response(new Uint8Array(preview), {
              headers: {
                "content-type": "image/jpeg",
                "cache-control": "public, max-age=31536000, immutable",
              },
            });
          }
        }

        try {
          const converted = await sharp(resolved).png().toBuffer();
          return new Response(new Uint8Array(converted), {
            headers: {
              "content-type": "image/png",
              "cache-control": "public, max-age=31536000, immutable",
            },
          });
        } catch (e) {
          log.warn(
            { filePath: resolved, err: e },
            "local-media: Conversion failed"
          );
          return new Response(buffer, {
            headers: {
              "content-type": getMimeType(ext),
              "cache-control": "public, max-age=31536000, immutable",
            },
          });
        }
      } catch {
        return new Response(null, { status: 404 });
      }
    });

    // ── Step 2: Show window immediately (user sees UI without delay) ──
    await setupORPC();
    createWindow();
    createTray();
    registerGlobalShortcuts();
    checkForUpdates();
    setupSendToShortcut();

    log.info("Window ready — starting background services...");

    // ── Step 3: Non-blocking background initialization ───────────────
    startBackgroundServices().catch((err) =>
      log.warn({ err }, "Non-critical services degraded")
    );

    // ── Background color data backfill (non-blocking, deferred 5s) ─────
    setTimeout(async () => {
      try {
        const db = getDatabase();
        const row = db
          .select({ value: appSettings.value })
          .from(appSettings)
          .where(eq(appSettings.key, "colors_migrated"))
          .get();

        if (!row || row.value !== "true") {
          log.info("[ColorMigration] Starting background color backfill...");
          const { runColorMigration } = await import(
            "@/ipc/photos/handlers/stats"
          );
          const result = await runColorMigration(false);
          log.info({ result }, "[ColorMigration] Background backfill complete");
        }
      } catch (err) {
        log.warn({ err }, "[ColorMigration] Startup backfill failed");
      }
    }, 5000);

    // Forward system theme changes to renderer
    nativeTheme.on("updated", () => {
      mainWindow?.webContents.send(
        "theme:system-changed",
        nativeTheme.shouldUseDarkColors ? "dark" : "light"
      );
    });

    // Handle files sent via SendTo or command-line
    const sentFilePaths = getSendToFilePaths();
    if (sentFilePaths.length > 0) {
      log.info(
        { count: sentFilePaths.length },
        "Received files via SendTo/CLI"
      );
      mainWindow?.webContents.once("did-finish-load", () => {
        mainWindow?.webContents.send("sendto:files", sentFilePaths);
      });
    }
  } catch (error) {
    const message = String(error);
    fs.writeFileSync(path.join(logDir, "whenReady.log"), `CATCH ${message}\n`);
    log.error({ err: error }, "Error during app initialization");
    dialog.showErrorBox("Startup Failed", message);
    app.quit();
  }
});

// ── Second instance: focus existing window ───────────────────────────
app.on("second-instance", (_event, _commandLine, _workingDirectory) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  }
});

// ── Window lifecycle ─────────────────────────────────────────────────
// Don't quit when all windows are closed (tray keeps app alive)
app.on("window-all-closed", () => {
  // macOS: standard behavior
  // Windows/Linux: tray keeps it alive
});

app.on("activate", () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
});

// ── Cleanup on quit ──────────────────────────────────────────────────
app.on("before-quit", () => {
  // Flip the flag so the close handler stops intercepting and lets the
  // window actually close. Required for app.quit() / app.relaunch() to work.
  isQuitting = true;
});

app.on("will-quit", async () => {
  try {
    fs.writeFileSync(
      path.join(logDir, "migrate.log"),
      `${new Date().toISOString()} will-quit: START\n`,
      { flag: "a" }
    );
  } catch {
    /* best-effort */
  }
  globalShortcut.unregisterAll();
  if (tray) {
    tray.destroy();
    tray = null;
  }
  await registry.stop();
  try {
    fs.writeFileSync(
      path.join(logDir, "migrate.log"),
      `${new Date().toISOString()} will-quit: DONE\n`,
      { flag: "a" }
    );
  } catch {
    /* best-effort */
  }
});
