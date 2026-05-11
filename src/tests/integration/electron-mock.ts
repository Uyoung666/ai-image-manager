/**
 * Electron mock for integration tests.
 * Provides app.getPath, screen.getPrimaryDisplay, etc.
 * Must be imported BEFORE any module that uses 'electron'.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TEST_DATA_DIR = path.join(os.tmpdir(), "ai-image-manager-test");

export function getTestDataDir(): string {
  return TEST_DATA_DIR;
}

export function setupTestDirs(): void {
  const dirs = [
    TEST_DATA_DIR,
    path.join(TEST_DATA_DIR, "thumbnails"),
    path.join(TEST_DATA_DIR, "vectors"),
    path.join(TEST_DATA_DIR, "models"),
    path.join(TEST_DATA_DIR, "data"),
  ];
  for (const d of dirs) {
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
    }
  }
}

export function cleanupTestDirs(): void {
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
}

// Electron app mock
export const app = {
  getPath(name: string): string {
    switch (name) {
      case "userData":
        return TEST_DATA_DIR;
      case "home":
        return os.homedir();
      case "appData":
        return path.join(os.homedir(), "AppData", "Roaming");
      default:
        return TEST_DATA_DIR;
    }
  },
  isPackaged: false,
  getAppPath(): string {
    return process.cwd();
  },
  whenReady(): Promise<void> {
    return Promise.resolve();
  },
  on(_event: string, _cb: Function): void {
    /* noop */
  },
  exit(_code?: number): void {
    /* noop */
  },
};

// Electron screen mock
export const screen = {
  getPrimaryDisplay(): { scaleFactor: number } {
    return { scaleFactor: 1 };
  },
};

// Electron BrowserWindow mock
export const BrowserWindow = class {};
export const Tray = class {};
export const Menu = {
  buildFromTemplate(_: unknown[]): unknown {
    return {};
  },
};
export const nativeImage = {
  createFromBuffer(_buf: Buffer, _opts: unknown): unknown {
    return {};
  },
};
export const ipcMain = { on: () => {} };
export const protocol = {
  registerSchemesAsPrivileged: () => {},
  handle: () => {},
};
export const globalShortcut = {
  register: () => true,
  unregisterAll: () => {},
};
