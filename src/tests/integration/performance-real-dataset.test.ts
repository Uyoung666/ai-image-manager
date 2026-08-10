/**
 * Real-dataset performance acceptance test.
 *
 * Run only when both paths are supplied:
 *   AIM_REAL_PERF_DATASET_DIR=D:\\path\\to\\photos
 *   AIM_REAL_PERF_DATA_DIR=D:\\path\\to\\isolated-data
 *   npx vitest run src/tests/integration/performance-real-dataset.test.ts
 *
 * The data directory is deliberately supplied by the caller so the test
 * cannot share the normal development profile. The test removes it in
 * afterAll; callers should still verify cleanup after an interrupted run.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const IMAGE_FILE_PATTERN =
  /\.(jpg|jpeg|png|webp|avif|tiff?|heic|heif|gif|bmp)$/i;
const datasetDir = process.env.AIM_REAL_PERF_DATASET_DIR
  ? path.resolve(process.env.AIM_REAL_PERF_DATASET_DIR)
  : "";
const dataDir = process.env.AIM_REAL_PERF_DATA_DIR
  ? path.resolve(process.env.AIM_REAL_PERF_DATA_DIR)
  : path.join(os.tmpdir(), "ai-image-manager-real-performance");
const expectedCount = Number.parseInt(
  process.env.AIM_REAL_PERF_EXPECTED_COUNT ?? "10000",
  10
);

vi.mock("electron", () => ({
  app: {
    getPath(name: string): string {
      if (name === "userData") {
        return dataDir;
      }
      if (name === "home") {
        return os.homedir();
      }
      return dataDir;
    },
    getAppPath(): string {
      return process.cwd();
    },
    isPackaged: false,
    on(_event: string, _callback: (...args: never[]) => unknown): void {
      /* noop */
    },
    whenReady(): Promise<void> {
      return Promise.resolve();
    },
  },
  BrowserWindow: class {},
  Menu: { buildFromTemplate: () => ({}) },
  Tray: class {},
  globalShortcut: {
    register: () => true,
    unregisterAll: () => {
      /* noop */
    },
  },
  ipcMain: {
    on: () => {
      /* noop */
    },
  },
  nativeImage: { createFromBuffer: () => ({}) },
  protocol: {
    handle: () => {
      /* noop */
    },
    registerSchemesAsPrivileged: () => {
      /* noop */
    },
  },
  screen: {
    getPrimaryDisplay: () => ({ scaleFactor: 1 }),
  },
}));

vi.mock("electron-store", () => ({
  default: class {
    private data = new Map<string, unknown>();

    get(key: string, defaultValue: unknown): unknown {
      return this.data.get(key) ?? defaultValue;
    }

    set(key: string, value: unknown): void {
      this.data.set(key, value);
    }
  },
}));

import { closeDatabase, getDatabase, initDatabase } from "@/db";
import { photos } from "@/db/schema";

const timings = {
  embeddingMs: 0,
  importMs: 0,
};

function listImages(): string[] {
  return fs
    .readdirSync(datasetDir)
    .filter((file) => IMAGE_FILE_PATTERN.test(file))
    .map((file) => path.join(datasetDir, file));
}

function cleanupDataDir(): void {
  if (fs.existsSync(dataDir)) {
    fs.rmSync(dataDir, { force: true, recursive: true });
  }
}

describe.skipIf(!datasetDir)(
  `real dataset performance (${expectedCount} photos)`,
  () => {
    beforeAll(async () => {
      if (path.resolve(dataDir) === path.resolve(datasetDir)) {
        throw new Error(
          "AIM_REAL_PERF_DATA_DIR must be different from the dataset directory"
        );
      }
      if (fs.existsSync(dataDir)) {
        throw new Error(
          `Refusing to overwrite existing performance data directory: ${dataDir}`
        );
      }
      fs.mkdirSync(dataDir, { recursive: true });
      initDatabase();
      const { initThumbnailer } = await import("@/services/thumbnailer");
      initThumbnailer();
    });

    afterAll(async () => {
      const { shutdownPool } = await import("@/services/embed-worker-pool");
      shutdownPool();
      closeDatabase();
      cleanupDataDir();
    });

    it("discovers the expected number of JPEG files", () => {
      const files = listImages();
      expect(files.length).toBe(expectedCount);
      expect(files.every((file) => fs.statSync(file).size > 0)).toBe(true);
    }, 120_000);

    it("measures folder import and thumbnail/index preparation", async () => {
      const { scanFolder } = await import("@/services/indexer");
      const startedAt = performance.now();
      const result = await scanFolder(datasetDir, (progress) => {
        if (
          progress.phase === "indexing" &&
          progress.scanned > 0 &&
          progress.scanned % 1000 === 0
        ) {
          console.log(
            `[real-perf] import ${progress.scanned}/${progress.total}`
          );
        }
      });
      timings.importMs = performance.now() - startedAt;

      expect(result.photoIds.length).toBe(expectedCount);
      console.log(
        `[real-perf] importMs=${timings.importMs.toFixed(0)} photos=${result.photoIds.length} skipped=${result.skipped}`
      );
    }, 3_600_000);

    it("measures SigLIP image embedding", async () => {
      const { embedAllPhotos } = await import("@/services/ai/embedder");
      const startedAt = performance.now();
      const embedded = await embedAllPhotos((progress) => {
        if (
          progress.phase === "embedding" &&
          progress.processed > 0 &&
          progress.processed % 1000 === 0
        ) {
          console.log(
            `[real-perf] embedding ${progress.processed}/${progress.total}`
          );
        }
      });
      timings.embeddingMs = performance.now() - startedAt;

      const db = getDatabase();
      const processed = db.select({ id: photos.id }).from(photos).all().length;
      expect(embedded).toBe(expectedCount);
      expect(processed).toBe(expectedCount);
      console.log(
        `[real-perf] embeddingMs=${timings.embeddingMs.toFixed(0)} embedded=${embedded}`
      );
      console.log(
        `[real-perf] totalMs=${(timings.importMs + timings.embeddingMs).toFixed(0)}`
      );
    }, 7_200_000);
  }
);
