import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  Menu,
  Notification,
  nativeImage,
  nativeTheme,
  powerMonitor,
  protocol,
  screen,
  session,
  shell,
  Tray,
} from "electron";
import { ipcMain } from "electron/main";
import started from "electron-squirrel-startup";
import Store from "electron-store";
import sharp from "sharp";
import { getDatabase } from "@/db";
import { appSettings, exifData, folders, photos, photoTags } from "@/db/schema";
import { ipcContext } from "@/ipc/context";
import {
  cleanupExpiredTrash,
  getOrphanPhotoIds,
} from "@/ipc/photos/handlers/mutations";
import { getActiveFaceModel } from "@/services/ai/face-model-config";
import {
  getEmbeddingModelFile,
  getTranslationModelFile,
} from "@/services/ai/model-config";
import { copyModelsOnce } from "@/services/ai/model-loader";
import { deletePhotoVectors, initVectorDB } from "@/services/ai-embedder";
import {
  appendDiagnosticLog,
  installConsoleDiagnostics,
  recordDiagnosticIncident,
} from "@/services/diagnostics";
import {
  DiagnosticSanitizer,
  sanitizeRendererRoute,
} from "@/services/diagnostics/sanitizer";
import {
  getHttpServerPort,
  startHttpServerEarly,
} from "@/services/http-server";
import { MODEL_MANIFEST, verifyModelFile } from "@/services/model-downloader";
import { extractRawPreview, isRawFile } from "@/services/raw-preview";
import { registry, ServiceLevel } from "@/services/registry";
import {
  getSendToFilePaths,
  setupSendToShortcut,
} from "@/services/sendto-integration";
import { getSetting } from "@/services/settings-manager";
import { generateThumbnail, getThumbnailDir } from "@/services/thumbnailer";
import {
  installUpdate,
  startUpdateManager,
  stopAutomaticChecks,
} from "@/services/update-manager";
import {
  createWanderLifecycleBridge,
  type WanderLifecycleBridge,
} from "@/services/wander-lifecycle";
import {
  APP_PREFERENCE_DEFAULTS,
  APP_PREFERENCE_KEYS,
  parseBooleanPreference,
  parseCloseBehavior,
} from "@/types/app-preferences";
import { getDataPath, initDataPath } from "@/utils/data-path";
import { getFolderPaths } from "@/utils/folder-paths";
import { IPC_CHANNELS, inDevelopment } from "./constants";
import { createLogger } from "./utils/logger.js";
import { getBasePath } from "./utils/path";
import { isSafePath } from "./utils/path-security.js";

const log = createLogger("main");
installConsoleDiagnostics();

// ── Squirrel startup event handling ──────────────────────────────────
if (started) {
  app.quit();
}

// E2E runs must not share the real profile or its single-instance lock.
// Set this before requestSingleInstanceLock() and before any userData access.
const e2eUserDataDir = process.env.AI_IMAGE_MANAGER_E2E_USER_DATA_DIR;
if (process.env.CI === "e2e" && e2eUserDataDir) {
  app.setPath("userData", path.resolve(e2eUserDataDir));
  app.disableHardwareAcceleration();
}

// Isolated verification env (e.g. face model upgrade A/B testing): an explicit
// user-data override that works outside E2E runs, so the real profile and its
// single-instance lock stay untouched. Set it, then add the same folder via
// Settings → Storage or app-config.json dataPath.
const devUserDataDir = process.env.AI_IMAGE_MANAGER_USER_DATA_DIR;
if (devUserDataDir) {
  app.setPath("userData", path.resolve(devUserDataDir));
}

// ── Single instance lock ─────────────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

let logDir: string | null = null;
const legacyLogSanitizer = new DiagnosticSanitizer();

// ── Log directory (scoped to app userData, not AppData root) ─────────
logDir = path.join(app.getPath("userData"), "logs");
fs.mkdirSync(logDir, { recursive: true });
fs.writeFileSync(
  path.join(logDir, "startup.log"),
  `STARTUP ${new Date().toISOString()} argv=${legacyLogSanitizer.sanitize(JSON.stringify(process.argv))}\n`,
  { flag: "a" }
);

app.on("child-process-gone", (_event, details) => {
  if (details.reason === "clean-exit") {
    return;
  }
  const message = `${details.type} process exited: ${details.reason} (${details.exitCode})`;
  const incident = recordDiagnosticIncident({
    source: "worker-crash",
    message,
  });
  appendDiagnosticLog({
    incidentId: incident.id,
    level: "error",
    message,
    module: details.name || details.type,
    process: "worker",
  });
});

function appendStartupLog(filename: string, message: string) {
  if (!logDir) {
    return;
  }
  try {
    fs.writeFileSync(
      path.join(logDir, filename),
      `${legacyLogSanitizer.sanitize(message)}\n`,
      { flag: "a" }
    );
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
      getEmbeddingModelFile(
        path.join(process.resourcesPath, "models-release"),
        "vision_model_quantized.onnx"
      )
    ),
    summarizePathState(
      "cached-model",
      getEmbeddingModelFile(
        path.join(getDataPath(), "models"),
        "vision_model_quantized.onnx"
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
let wanderLifecycleBridge: WanderLifecycleBridge | null = null;
// True once before-quit fires — distinguishes "user clicked close" (hide to
// tray) from "app actually quitting" (e.g. relaunch, tray menu Exit, OS
// shutdown). Without this flag, every close is intercepted and app.quit()
// becomes a no-op, breaking app.relaunch() and similar flows.
let isQuitting = false;

// Periodic trash cleanup timer (runs every 6 hours to enforce 30-day retention)
let trashCleanupTimer: ReturnType<typeof setInterval> | null = null;
const TRASH_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// ── Window state store (lazy init) ───────────────────────────────────
let windowStore: Store<{
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  isMaximized?: boolean;
  trayMinimizeHinted: boolean;
}>;

function getWindowStore() {
  if (!windowStore) {
    windowStore = new Store<{
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      isMaximized?: boolean;
      trayMinimizeHinted: boolean;
    }>({
      name: "window-state",
      defaults: { width: 1280, height: 800, trayMinimizeHinted: false },
    });
  }
  return windowStore;
}

function getWindowPreferences() {
  try {
    return {
      closeBehavior: parseCloseBehavior(
        getSetting(APP_PREFERENCE_KEYS.closeBehavior)
      ),
      rememberBounds: parseBooleanPreference(
        getSetting(APP_PREFERENCE_KEYS.rememberBounds),
        APP_PREFERENCE_DEFAULTS.rememberBounds
      ),
    };
  } catch {
    return {
      closeBehavior: APP_PREFERENCE_DEFAULTS.closeBehavior,
      rememberBounds: APP_PREFERENCE_DEFAULTS.rememberBounds,
    };
  }
}

function isBoundsVisible(bounds: {
  height: number;
  width: number;
  x: number;
  y: number;
}): boolean {
  try {
    return screen.getAllDisplays().some((display) => {
      const right = Math.min(
        bounds.x + bounds.width,
        display.workArea.x + display.workArea.width
      );
      const bottom = Math.min(
        bounds.y + bounds.height,
        display.workArea.y + display.workArea.height
      );
      const left = Math.max(bounds.x, display.workArea.x);
      const top = Math.max(bounds.y, display.workArea.y);
      return right - left >= 32 && bottom - top >= 32;
    });
  } catch {
    return false;
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = null;
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

// ── Tray language store ────────────────────────────────────────────
type TrayLang = "zh" | "en";

const trayLabels: Record<
  TrayLang,
  {
    closeWindowQuestion: string;
    closeWindowTitle: string;
    launchAtStartup: string;
    minimizeToTray: string;
    quit: string;
    showWindow: string;
    tooltip: string;
  }
> = {
  zh: {
    closeWindowQuestion: "关闭窗口时要如何处理？",
    closeWindowTitle: "关闭窗口",
    showWindow: "显示窗口",
    launchAtStartup: "开机自启",
    minimizeToTray: "最小化到托盘",
    quit: "退出",
    tooltip: "AI 图片管理器",
  },
  en: {
    closeWindowQuestion: "What should happen when the window is closed?",
    closeWindowTitle: "Close window",
    showWindow: "Show Window",
    launchAtStartup: "Launch at Startup",
    minimizeToTray: "Minimize to tray",
    quit: "Quit",
    tooltip: "AI Image Manager",
  },
};

function getTrayLangStore(): Store<{ language: string }> {
  if (!trayLangStore) {
    trayLangStore = new Store<{ language: string }>({
      name: "tray-lang",
      defaults: { language: "zh" },
    });
  }
  return trayLangStore;
}

let trayLangStore: Store<{ language: string }> | null = null;

function tTray(key: keyof (typeof trayLabels)["zh"]): string {
  const lang = (getTrayLangStore().get("language") as string) || "zh";
  const safe = (trayLabels as Record<string, Record<string, string>>)[lang];
  return safe?.[key] ?? trayLabels.zh[key];
}

// ── Tray icon ────────────────────────────────────────────────────────
function getIconPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "icon.png");
  }
  return path.join(app.getAppPath(), "assets", "icon.png");
}

function buildTrayMenu(): Electron.Menu {
  return Menu.buildFromTemplate([
    {
      label: tTray("showWindow"),
      click: () => {
        showMainWindow();
      },
    },
    { type: "separator" },
    {
      label: tTray("launchAtStartup"),
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (menuItem) => {
        app.setLoginItemSettings({ openAtLogin: menuItem.checked });
      },
    },
    { type: "separator" },
    {
      label: tTray("quit"),
      click: () => {
        app.quit();
      },
    },
  ]);
}

function rebuildTrayMenu() {
  if (tray) {
    tray.setContextMenu(buildTrayMenu());
    tray.setToolTip(tTray("tooltip"));
  }
}

function createTray() {
  const iconPath = getIconPath();
  if (fs.existsSync(iconPath)) {
    const img = nativeImage.createFromPath(iconPath);
    tray = new Tray(img.resize({ width: 16, height: 16 }));
  } else {
    tray = new Tray(nativeImage.createEmpty());
  }
  tray.setToolTip(tTray("tooltip"));

  tray.setContextMenu(buildTrayMenu());

  tray.on("double-click", () => {
    showMainWindow();
  });
}

// ── Global shortcuts ─────────────────────────────────────────────────
function registerGlobalShortcuts() {
  const searchRegistered = globalShortcut.register("Ctrl+Shift+F", () => {
    if (mainWindow) {
      showMainWindow();
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

// ── I/O 信号量：限制 local-media:// 协议的并发文件操作 ──────────
// 防止快速滚动时数十个并发 readFile + sharp 打爆磁盘 I/O。
// 信号量在模块顶层创建，生命周期 = 应用生命周期。
class IoSemaphore {
  private running = 0;
  private readonly pending: Array<() => void> = [];
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.pending.push(resolve);
    });
  }

  release(): void {
    this.running--;
    const next = this.pending.shift();
    if (next) {
      this.running++;
      next();
    }
  }
}

const mediaSemaphore = new IoSemaphore(16);

// ── 文件夹列表缓存 ── 由 @/utils/folder-paths 集中管理，供 local-media 协议、
// HTTP 服务器的路径安全校验和索引模块共用。
// 缓存 TTL 10 秒；索引变更（新建/删除文件夹）通过 invalidateFoldersCache() 主动失效。
//
// ── AI model availability (copy from resources or dev paths) ─────────

async function verifyCurrentFaceModels(modelsDir: string): Promise<{
  invalidFiles: string[];
  valid: boolean;
}> {
  const activeFaceModel = getActiveFaceModel();
  const invalidFiles: string[] = [];

  for (const fileName of activeFaceModel.modelFiles) {
    const entry = MODEL_MANIFEST.find(
      (candidate) =>
        candidate.subPath === "face" && candidate.fileName === fileName
    );
    const filePath = path.join(modelsDir, "face", fileName);
    if (
      !(
        entry &&
        (await verifyModelFile(filePath, entry.sha256, entry.sizeBytes))
      )
    ) {
      invalidFiles.push(fileName);
    }
  }

  return { invalidFiles, valid: invalidFiles.length === 0 };
}

async function hasCurrentModels(modelsDir: string): Promise<boolean> {
  const markers = [
    getEmbeddingModelFile(modelsDir, "vision_model_quantized.onnx"),
    getTranslationModelFile(modelsDir, "encoder_model_quantized.onnx"),
    getTranslationModelFile(modelsDir, "decoder_model_merged_quantized.onnx"),
  ];
  const faceValidation = await verifyCurrentFaceModels(modelsDir);
  return (
    markers.every((marker) => fs.existsSync(marker)) && faceValidation.valid
  );
}

async function copyBundledModels(modelsDir: string): Promise<void> {
  const bundledModels = path.join(process.resourcesPath, "models-release");
  const bundledMarker = getEmbeddingModelFile(
    bundledModels,
    "vision_model_quantized.onnx"
  );
  const bundledFaceValidation = await verifyCurrentFaceModels(bundledModels);

  log.info(
    "[ensureModelAvailable] bundledModels=%s exists=%s bundledMarker=%s exists=%s faceValid=%s",
    bundledModels,
    fs.existsSync(bundledModels),
    bundledMarker,
    fs.existsSync(bundledMarker),
    bundledFaceValidation.valid
  );
  if (!(fs.existsSync(bundledMarker) && bundledFaceValidation.valid)) {
    throw new Error(
      `Bundled AI models are incomplete or failed hash verification; invalid face files: ${bundledFaceValidation.invalidFiles.join(", ") || "none"}`
    );
  }

  log.info("Copying AI models from bundled resources...");
  try {
    await copyModelsOnce();
    await fs.promises.cp(
      path.join(bundledModels, "face"),
      path.join(modelsDir, "face"),
      { recursive: true }
    );
    const copied = await hasCurrentModels(modelsDir);
    const visionMarker = getEmbeddingModelFile(
      modelsDir,
      "vision_model_quantized.onnx"
    );
    const size = fs.existsSync(visionMarker)
      ? fs.statSync(visionMarker).size
      : 0;
    log.info(
      "[ensureModelAvailable] copy done — marker exists=%s size=%d",
      copied,
      size
    );
    if (!copied || size <= 0) {
      throw new Error(
        "Copied AI models failed startup verification, including the active face model"
      );
    }
    log.info("AI models copied and current face model hashes verified");
  } catch (err) {
    log.error({ err }, "Failed to copy AI models from resources");
    throw err;
  }
}

async function copyDevModels(modelsDir: string): Promise<void> {
  const devCandidates = [
    path.join(process.cwd(), "models"),
    path.join(app.getAppPath(), "models"),
    path.join(app.getAppPath(), "..", "models"),
    path.join(app.getAppPath(), "..", "..", "models"),
  ];
  for (const candidate of devCandidates) {
    const marker = getEmbeddingModelFile(
      candidate,
      "vision_model_quantized.onnx"
    );
    log.debug({ marker }, "Checking for AI model");
    if (!fs.existsSync(marker)) {
      continue;
    }
    log.info({ source: candidate }, "Copying AI models from dev path");
    try {
      await fs.promises.cp(candidate, modelsDir, { recursive: true });
      const copiedFaceValidation = await verifyCurrentFaceModels(modelsDir);
      if (copiedFaceValidation.valid) {
        log.info("AI models copied and current face model hashes verified");
        return;
      }
      log.warn(
        {
          invalidFiles: copiedFaceValidation.invalidFiles,
          source: candidate,
        },
        "Dev model copy rejected because the active face model failed hash verification"
      );
    } catch (err) {
      log.warn({ err, source: candidate }, "Failed to copy from dev path");
    }
  }
  log.warn("AI models not found in any dev path");
}

async function ensureModelAvailable(): Promise<void> {
  const modelsDir = path.join(getDataPath(), "models");
  if (await hasCurrentModels(modelsDir)) {
    log.info(
      "AI models already cached and face hashes verified at %s",
      modelsDir
    );
    return;
  }
  if (app.isPackaged) {
    await copyBundledModels(modelsDir);
    return;
  }
  await copyDevModels(modelsDir);
}

// ── UI zoom scale ────────────────────────────────────────────────────
// Persisted via the app_settings table (key "ui.zoomScale"), applied on
// every window load so the preference survives restarts. Defaults to 1
// (follow system DPI); the settings → appearance page offers 80%–130%.
function applyUiZoomScale() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  try {
    const db = getDatabase();
    const row = db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, "ui.zoomScale"))
      .get();
    const parsed = Number.parseFloat(row?.value ?? "");
    const scale = Number.isFinite(parsed)
      ? Math.min(2, Math.max(0.5, parsed))
      : 1;
    mainWindow.webContents.setZoomFactor(scale);
  } catch {
    // DB not ready yet — leave the default zoom; the settings page will
    // apply the stored value the next time it changes.
  }
}

// ── Create main window ───────────────────────────────────────────────
function createWindow(httpPort: number) {
  const modulePath = getBasePath();
  const basePath =
    path.basename(modulePath) === "chunks"
      ? path.dirname(modulePath)
      : modulePath;
  const preload = path.join(basePath, "preload.js");

  const store = getWindowStore();
  const windowPreferences = getWindowPreferences();
  const savedWidth = windowPreferences.rememberBounds
    ? store.get("width", 1280)
    : 1280;
  const savedHeight = windowPreferences.rememberBounds
    ? store.get("height", 800)
    : 800;
  const savedX = windowPreferences.rememberBounds ? store.get("x") : undefined;
  const savedY = windowPreferences.rememberBounds ? store.get("y") : undefined;
  const savedBounds =
    savedX !== undefined && savedY !== undefined
      ? { height: savedHeight, width: savedWidth, x: savedX, y: savedY }
      : null;

  mainWindow = new BrowserWindow({
    width: savedWidth,
    height: savedHeight,
    minWidth: 720,
    minHeight: 480,
    show: false,
    ...(savedBounds && isBoundsVisible(savedBounds)
      ? { x: savedX, y: savedY }
      : {}),
    title: "AI Image Manager",
    icon: app.isPackaged
      ? path.join(process.resourcesPath, "icon.png")
      : path.join(app.getAppPath(), "assets", "icon.png"),
    webPreferences: {
      additionalArguments: [
        `--http-port=${httpPort}`,
        ...(process.env.CI === "e2e" ? ["--e2e"] : []),
      ],
      devTools: inDevelopment,
      contextIsolation: true,
      nodeIntegration: false,
      preload,
    },
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    trafficLightPosition:
      process.platform === "darwin" ? { x: 12, y: 9 } : undefined,
  });

  wanderLifecycleBridge?.dispose();
  const lifecycleWindow = mainWindow;
  const lifecycleBridge = createWanderLifecycleBridge({
    powerMonitor,
    send: (state) => {
      if (!lifecycleWindow.isDestroyed()) {
        lifecycleWindow.webContents.send(IPC_CHANNELS.WANDER_LIFECYCLE, state);
      }
    },
    window: lifecycleWindow,
  });
  wanderLifecycleBridge = lifecycleBridge;

  if (windowPreferences.rememberBounds && store.get("isMaximized", false)) {
    mainWindow.maximize();
  }

  let closePromptOpen = false;
  mainWindow.on("close", (event) => {
    if (isQuitting) {
      return;
    }

    const { closeBehavior } = getWindowPreferences();
    if (closeBehavior === "quit" || !tray) {
      event.preventDefault();
      isQuitting = true;
      app.quit();
      return;
    }

    event.preventDefault();
    if (closeBehavior === "tray") {
      hideMainWindowToTray();
      return;
    }

    if (closePromptOpen) {
      return;
    }
    closePromptOpen = true;
    const window = mainWindow;
    if (!window || window.isDestroyed()) {
      closePromptOpen = false;
      return;
    }
    dialog
      .showMessageBox(window, {
        buttons: [tTray("minimizeToTray"), tTray("quit")],
        cancelId: 0,
        defaultId: 0,
        message: tTray("closeWindowQuestion"),
        title: tTray("closeWindowTitle"),
        type: "question",
      })
      .then(({ response }) => {
        if (response === 1) {
          isQuitting = true;
          app.quit();
        } else {
          hideMainWindowToTray();
        }
      })
      .finally(() => {
        closePromptOpen = false;
      });
  });

  function hideMainWindowToTray() {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    if (!store.get("trayMinimizeHinted", false)) {
      store.set("trayMinimizeHinted", true);
      if (Notification.isSupported()) {
        new Notification({
          title: "AI Image Manager",
          body: "应用已最小化至系统托盘，双击托盘图标可重新打开",
          silent: false,
        }).show();
      }
    }
    mainWindow.hide();
  }

  const saveBounds = () => {
    if (!getWindowPreferences().rememberBounds) {
      return;
    }
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
  mainWindow.on("maximize", () => {
    if (getWindowPreferences().rememberBounds) {
      store.set("isMaximized", true);
    }
    mainWindow?.webContents.send("window:maximize-change", true);
  });
  mainWindow.on("unmaximize", () => {
    if (getWindowPreferences().rememberBounds) {
      store.set("isMaximized", false);
    }
    mainWindow?.webContents.send("window:maximize-change", false);
  });
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
  mainWindow.webContents.on("did-finish-load", () => {
    lifecycleBridge.publish("initial");
    applyUiZoomScale();
  });
  mainWindow.webContents.on("console-message", (details) => {
    if (details.level !== "warning" && details.level !== "error") {
      return;
    }
    appendDiagnosticLog({
      action: details.level === "error" ? "console-error" : "console-warning",
      level: details.level === "error" ? "error" : "warn",
      message: details.message,
      module: "renderer-console",
      process: "renderer",
      route: sanitizeRendererRoute(
        mainWindow?.webContents.getURL().split("#").at(-1) || "/"
      ),
      source: `${details.sourceId}:${details.lineNumber}`,
    });
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    const message = `Renderer process exited: ${details.reason} (${details.exitCode})`;
    const incident = recordDiagnosticIncident({
      source: "renderer-crash",
      message,
    });
    appendDiagnosticLog({
      incidentId: incident.id,
      level: "error",
      message,
      module: "renderer-lifecycle",
      process: "main",
    });
    dialog
      .showMessageBox({
        type: "error",
        title: "AI Image Manager",
        message: "界面进程意外退出 / The interface process crashed",
        detail: `事件编号 / Incident: ${incident.id}\n可在“设置 → 帮助与诊断”生成反馈包。`,
        buttons: ["重新加载 / Reload", "关闭 / Close"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0 && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.reload();
        }
      })
      .catch((error) => {
        appendDiagnosticLog({
          incidentId: incident.id,
          level: "error",
          message: error instanceof Error ? error.message : String(error),
          module: "renderer-crash-dialog",
          process: "main",
        });
      });
  });

  ipcContext.setMainWindow(mainWindow);

  // typeof guard: prevents ReferenceError in production strict mode
  const windowLoad =
    typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === "undefined"
      ? mainWindow.loadFile(
          path.join(basePath, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
        )
      : mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  windowLoad.catch((error) => {
    const incident = recordDiagnosticIncident({
      message: error instanceof Error ? error.message : String(error),
      source: "startup-failure",
      stack: error instanceof Error ? error.stack : undefined,
    });
    appendDiagnosticLog({
      incidentId: incident.id,
      level: "error",
      message: incident.message,
      module: "renderer-load",
      process: "main",
      stack: incident.stack,
    });
  });

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

// ── Update proxy config ──────────────────────────────────────────────
function getUpdateConfigStore() {
  if (!__updateConfigStore) {
    __updateConfigStore = new Store<{
      proxy: string;
    }>({
      name: "update-config",
      defaults: { proxy: "" },
    });
  }
  return __updateConfigStore;
}
let __updateConfigStore: Store<{ proxy: string }> | null = null;

async function applyProxyConfig() {
  const proxy = getUpdateConfigStore().get("proxy", "");
  if (proxy) {
    await session.defaultSession.setProxy({ proxyRules: proxy });
    log.info({ proxy }, "Update proxy configured");
  }
}

// ── Auto-update check ────────────────────────────────────────────────
function checkForUpdates() {
  startUpdateManager();
  /*
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
      broadcastUpdateStatus({
        phase: "downloaded",
        version: info.releaseName,
        releaseNotes: info.releaseNotes,
        releaseDate: info.releaseDate,
        updateURL: info.updateURL,
      });
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
    const raw = err?.message || String(err);
    let code = raw;
    if (NETWORK_ERROR_RE.test(raw)) {
      code = "NETWORK_ERROR";
    } else if (HTTP_ERROR_RE.test(raw)) {
      code = "UPDATE_NOT_FOUND";
    } else if (/acquire.*lock|another.*instance|mutex/i.test(raw)) {
      // Squirrel.Windows lock contention — another instance is running or
      // stale lock file; not actionable by user, don't show in UI
      log.warn(
        { raw },
        "[updater] Squirrel lock contention, suppressing error"
      );
      return; // Don't broadcast — this is a transient Squirrel-internal error
    }
    // Truncate raw Squirrel/.NET stack traces — they contain GBK-garbled text
    // that renders as mojibake in the UI
    const sanitized = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
    broadcastUpdateStatus({ phase: "error", message: sanitized });
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
    // download-progress not available
  }

  log.info("Update checker started");
  */
}

ipcMain.on("app:restart", () => {
  app.relaunch({
    args: process.argv.slice(1).concat(["--relaunch"]),
    execPath: process.execPath,
  });
  app.quit();
});

ipcMain.on("app:install-update", () => {
  fs.writeFileSync(
    path.join(logDir, "startup.log"),
    `${new Date().toISOString()} install-update: quitAndInstall\n`,
    { flag: "a" }
  );
  installUpdate();
});

// Sync language from renderer to main process (updates tray menu labels)
ipcMain.on("app:language-changed", (_event, lang: string) => {
  if (lang && (lang === "zh" || lang === "en")) {
    getTrayLangStore().set("language", lang);
    rebuildTrayMenu();
  }
});

ipcMain.on("shell:open-external", (_event, url: string) => {
  if (url && typeof url === "string") {
    shell.openExternal(url).catch((err) => {
      log.error("Failed to open external URL:", err);
    });
  }
});

ipcMain.on(IPC_CHANNELS.IS_DIRECTORY_PATH, (event, filePath: unknown) => {
  if (typeof filePath !== "string" || !filePath) {
    event.returnValue = false;
    return;
  }
  try {
    event.returnValue = fs.statSync(filePath).isDirectory();
  } catch {
    event.returnValue = false;
  }
});

ipcMain.handle("app:get-http-port", () => {
  return getHttpServerPort();
});

ipcMain.handle("clipboard:copy-image", async (_event, filePath: string) => {
  if (!filePath || typeof filePath !== "string") {
    return false;
  }
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
  } catch {
    log.warn({ filePath }, "clipboard:copy-image — file not accessible");
    return false;
  }
  try {
    const img = nativeImage.createFromPath(filePath);
    if (img.isEmpty()) {
      log.warn({ filePath }, "clipboard:copy-image — nativeImage is empty");
      return false;
    }
    clipboard.writeImage(img);
    return true;
  } catch (err) {
    log.error({ filePath, err }, "clipboard:copy-image — failed");
    return false;
  }
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
    const orphanIds = getOrphanPhotoIds(db);

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

  // ── Expired trash cleanup: permanently delete photos in trash > 30 days ──
  try {
    const expiredCount = await cleanupExpiredTrash();
    if (expiredCount > 0) {
      log.info(
        { count: expiredCount },
        "Startup cleanup: removed expired trash photos"
      );
    }
  } catch (err) {
    log.warn({ err }, "Expired trash cleanup skipped");
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

    // 模型复制和服务初始化并行：AI 服务在模型就绪前启动会优雅降级
    const modelPromise = ensureModelAvailable();
    await registry.startRemaining();
    log.info("All services started");
    logMain("[bg] startRemaining done");

    await modelPromise;
    logMain("[bg] ensureModelAvailable done");

    // ── Periodic trash cleanup: enforce 30-day retention even when app runs for days ──
    trashCleanupTimer = setInterval(() => {
      cleanupExpiredTrash()
        .then((count) => {
          if (count > 0) {
            log.info(
              { count },
              "Periodic cleanup: removed expired trash photos"
            );
          }
        })
        .catch((err) => {
          log.warn({ err }, "Periodic trash cleanup failed");
        });
    }, TRASH_CLEANUP_INTERVAL_MS);
    logMain(
      `[bg] Periodic trash cleanup scheduled (every ${TRASH_CLEANUP_INTERVAL_MS / 3_600_000}h)`
    );
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

// Windows AUMID — 没有它 dev 模式下 Notification 会被系统静默丢弃
if (process.platform === "win32") {
  app.setAppUserModelId("com.aiimagemanager.app");
}

const BROWSER_COMPATIBLE_EXTENSIONS = new Set([
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

function notFoundResponse(): Response {
  return new Response(null, { status: 404 });
}

async function ensureLocalMediaFile(resolved: string): Promise<boolean> {
  if (fs.existsSync(resolved)) {
    return true;
  }
  const thumbDir = getThumbnailDir();
  if (!(thumbDir && resolved.startsWith(thumbDir))) {
    return false;
  }
  const photo = getDatabase()
    .select({ path: photos.path })
    .from(photos)
    .where(eq(photos.thumbnailPath, resolved))
    .get();
  if (!photo) {
    return false;
  }
  try {
    await generateThumbnail(photo.path, "md");
    return fs.existsSync(resolved);
  } catch (err) {
    log.warn(
      { filePath: resolved, err },
      "local-media: Thumbnail regeneration failed"
    );
    return false;
  }
}

async function renderLocalMedia(resolved: string): Promise<Response> {
  if (!(await ensureLocalMediaFile(resolved))) {
    return notFoundResponse();
  }
  const ext = path.extname(resolved).toLowerCase();
  const buffer = await fs.promises.readFile(resolved);
  if (BROWSER_COMPATIBLE_EXTENSIONS.has(ext)) {
    return new Response(buffer, {
      headers: {
        "content-type": getMimeType(ext),
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }
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
    const converted = await sharp(resolved).rotate().png().toBuffer();
    return new Response(new Uint8Array(converted), {
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    log.warn({ filePath: resolved, err }, "local-media: Conversion failed");
    return new Response(buffer, {
      headers: {
        "content-type": getMimeType(ext),
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }
}

async function handleLocalMediaRequest(request: {
  url: string;
}): Promise<Response> {
  try {
    const encodedPath = request.url.slice("local-media://".length);
    const filePath = decodeURIComponent(encodedPath);
    const resolved = path.resolve(filePath);
    const allowedPaths = [getDataPath(), ...getFolderPaths()];
    if (!isSafePath(resolved, allowedPaths)) {
      log.warn({ filePath }, "Security: local-media blocked");
      return new Response(null, { status: 403 });
    }
    await mediaSemaphore.acquire();
    try {
      return await renderLocalMedia(resolved);
    } finally {
      mediaSemaphore.release();
    }
  } catch (err) {
    log.debug({ err }, "local-media: Request failed");
    return notFoundResponse();
  }
}

app.whenReady().then(async () => {
  // Squirrel.Windows event (install/update/obsolete): quit immediately,
  // don't run expensive init like model copying — the process gets killed
  // and partial copies cause "AI embedding failure" on next launch.
  if (started) {
    return;
  }

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
    protocol.handle("local-media", handleLocalMediaRequest);

    // ── Step 2: Start HTTP server (must be ready before window loads) ──
    const httpPort = await startHttpServerEarly();
    log.info({ port: httpPort }, "HTTP server started");

    await setupORPC();
    createWindow(httpPort);
    createTray();
    registerGlobalShortcuts();
    await applyProxyConfig();
    checkForUpdates();
    setupSendToShortcut();

    log.info("Window ready — starting background services...");

    // ── Step 3: Non-blocking background initialization ───────────────
    // GPU detection is now handled on-demand by the Onboarding overlay
    // (step 2) and the Settings page's GpuSettingsCard — no automatic
    // startup popup needed.
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

    // MakerNote enrichment is deferred and never blocks the basic import path.
    setTimeout(() => {
      import("@/services/advanced-exif")
        .then(({ scheduleAdvancedExifEnrichment }) =>
          scheduleAdvancedExifEnrichment(0)
        )
        .catch((err) =>
          log.warn({ err }, "[AdvancedExif] Startup enrichment failed")
        );
    }, 8000);

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
  showMainWindow();
});

// ── Window lifecycle ─────────────────────────────────────────────────
// Don't quit when all windows are closed (tray keeps app alive)
app.on("window-all-closed", () => {
  // macOS: standard behavior
  // Windows/Linux: tray keeps it alive
});

app.on("activate", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showMainWindow();
  } else {
    mainWindow = null;
    createWindow(getHttpServerPort() ?? 0);
  }
});

// ── Cleanup on quit ──────────────────────────────────────────────────
app.on("before-quit", () => {
  // Flip the flag so the close handler stops intercepting and lets the
  // window actually close. Required for app.quit() / app.relaunch() to work.
  isQuitting = true;
});

app.on("will-quit", async () => {
  stopAutomaticChecks();
  try {
    fs.writeFileSync(
      path.join(logDir, "migrate.log"),
      `${new Date().toISOString()} will-quit: START\n`,
      { flag: "a" }
    );
  } catch {
    /* best-effort */
  }
  // Clear periodic trash cleanup timer
  if (trashCleanupTimer) {
    clearInterval(trashCleanupTimer);
    trashCleanupTimer = null;
  }
  globalShortcut.unregisterAll();
  wanderLifecycleBridge?.dispose();
  wanderLifecycleBridge = null;
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
