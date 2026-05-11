/**
 * @vitest-environment node
 *
 * Smart Album Engine — edge case tests.
 * Tests rule evaluation, intersections, date presets, and error handling.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const TEST_DATA_DIR = path.join(os.tmpdir(), "ai-image-manager-test-smart");

vi.mock("electron", () => ({
  app: {
    getPath(name: string): string {
      return name === "userData" ? TEST_DATA_DIR : TEST_DATA_DIR;
    },
    isPackaged: false,
    getAppPath(): string { return process.cwd(); },
    whenReady(): Promise<void> { return Promise.resolve(); },
    on(_event: string, _cb: Function): void {},
    exit(_code?: number): void {},
  },
  screen: {
    getPrimaryDisplay(): { scaleFactor: number } {
      return { scaleFactor: 1 };
    },
  },
  BrowserWindow: class {},
  Tray: class {},
  Menu: { buildFromTemplate: () => ({}) },
  nativeImage: { createFromBuffer: () => ({}) },
  ipcMain: { on: () => {} },
  protocol: {
    registerSchemesAsPrivileged: () => {},
    handle: () => {},
  },
  globalShortcut: {
    register: () => true,
    unregisterAll: () => {},
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

import { initDatabase } from "@/db";
import { evaluateSmartAlbum, validateSmartRules } from "@/services/smart-album-engine";

function setupTestDirs(): void {
  const dirs = [
    TEST_DATA_DIR,
    path.join(TEST_DATA_DIR, "thumbnails"),
    path.join(TEST_DATA_DIR, "vectors"),
    path.join(TEST_DATA_DIR, "data"),
  ];
  for (const d of dirs) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function cleanupTestDirs(): void {
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
}

beforeAll(() => {
  cleanupTestDirs();
  setupTestDirs();
  initDatabase();
});

afterAll(() => {
  cleanupTestDirs();
});

describe("smart-album-engine", () => {
  // --- JSON Validation ---

  describe("validateSmartRules", () => {
    it("rejects empty JSON", () => {
      const result = validateSmartRules("{}");
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("rejects non-array rules", () => {
      const result = validateSmartRules(JSON.stringify({ rules: "not-an-array" }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain("数组");
    });

    it("rejects invalid JSON string", () => {
      const result = validateSmartRules("{invalid json");
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("rejects null input", () => {
      const result = validateSmartRules("null");
      expect(result.valid).toBe(false);
    });

    it("accepts valid rules with empty array", () => {
      const result = validateSmartRules(JSON.stringify({ rules: [] }));
      expect(result.valid).toBe(true);
      expect(result.matchCount).toBe(0);
    });

    it("accepts valid rules with date preset", () => {
      const result = validateSmartRules(JSON.stringify({
        rules: [{ type: "dateRange", preset: "最近7天" }],
      }));
      expect(result.valid).toBe(true);
    });

    it("handles malformed rule type gracefully", () => {
      const result = validateSmartRules(JSON.stringify({
        rules: [{ type: "nonexistentType", value: "test" }],
      }));
      expect(result.valid).toBe(true);
      expect(result.matchCount).toBe(0);
    });

    it("handles tags rule with empty value array", () => {
      const result = validateSmartRules(JSON.stringify({
        rules: [{ type: "tags", operator: "包含任一", value: [] }],
      }));
      expect(result.valid).toBe(true);
      expect(result.matchCount).toBe(0);
    });

    it("handles file format rule", () => {
      const result = validateSmartRules(JSON.stringify({
        rules: [{ type: "fileFormat", value: "jpg" }],
      }));
      expect(result.valid).toBe(true);
    });
  });

  // --- Rule Evaluation ---

  describe("evaluateSmartAlbum", () => {
    it("returns empty array for empty rules", () => {
      const result = evaluateSmartAlbum({ rules: [] });
      expect(result).toEqual([]);
    });

    it("does not throw on single rule with no matches", () => {
      const result = evaluateSmartAlbum({
        rules: [{ type: "cameraModel", operator: "等于", value: "NonExistentCameraXYZ" }],
      });
      expect(result).toEqual([]);
    });

    it("does not crash on conflicting date/format rules", () => {
      const result = evaluateSmartAlbum({
        rules: [
          { type: "dateRange", preset: "最近7天" },
          { type: "fileFormat", value: "nonexistent_format_xyz" },
        ],
      });
      expect(result).toEqual([]);
    });

    it("handles number range operator with missing max", () => {
      const result = evaluateSmartAlbum({
        rules: [{ type: "iso", operator: "范围", value: 100 }],
      });
      expect(Array.isArray(result)).toBe(true);
    });

    it("handles focal length >= operator", () => {
      const result = evaluateSmartAlbum({
        rules: [{ type: "focalLength", operator: ">=", value: 50 }],
      });
      expect(Array.isArray(result)).toBe(true);
    });

    it("handles aperture <= operator", () => {
      const result = evaluateSmartAlbum({
        rules: [{ type: "aperture", operator: "<=", value: 5.6 }],
      });
      expect(Array.isArray(result)).toBe(true);
    });

    it("handles ISO range operator with max", () => {
      const result = evaluateSmartAlbum({
        rules: [{ type: "iso", operator: "范围", value: 100, max: 800 }],
      });
      expect(Array.isArray(result)).toBe(true);
    });

    it("handles tags with 包含全部 operator", () => {
      const result = evaluateSmartAlbum({
        rules: [{ type: "tags", operator: "包含全部", value: ["夜景", "城市"] }],
      });
      expect(Array.isArray(result)).toBe(true);
    });

    it("handles tags with 包含任一 operator", () => {
      const result = evaluateSmartAlbum({
        rules: [{ type: "tags", operator: "包含任一", value: ["海滩", "山脉"] }],
      });
      expect(Array.isArray(result)).toBe(true);
    });

    it("handles camera model contains match", () => {
      const result = evaluateSmartAlbum({
        rules: [{ type: "cameraModel", operator: "包含", value: "Sony" }],
      });
      expect(Array.isArray(result)).toBe(true);
    });

    it("handles lens model equal match", () => {
      const result = evaluateSmartAlbum({
        rules: [{ type: "lensModel", operator: "等于", value: "FE 24-70mm" }],
      });
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // --- Date Preset Resolution ---
  describe("date presets", () => {
    it('resolves "最近7天" within date range', () => {
      const result = validateSmartRules(JSON.stringify({
        rules: [{ type: "dateRange", preset: "最近7天" }],
      }));
      expect(result.valid).toBe(true);
    });

    it('resolves "最近30天" without error', () => {
      const result = validateSmartRules(JSON.stringify({
        rules: [{ type: "dateRange", preset: "最近30天" }],
      }));
      expect(result.valid).toBe(true);
    });

    it('resolves "今年" without error', () => {
      const result = validateSmartRules(JSON.stringify({
        rules: [{ type: "dateRange", preset: "今年" }],
      }));
      expect(result.valid).toBe(true);
    });

    it('resolves "去年今日" without error', () => {
      const result = validateSmartRules(JSON.stringify({
        rules: [{ type: "dateRange", preset: "去年今日" }],
      }));
      expect(result.valid).toBe(true);
    });

    it("handles custom date range with timestamps", () => {
      const result = validateSmartRules(JSON.stringify({
        rules: [
          { type: "dateRange", dateFrom: 946684800000, dateTo: 978307200000 },
        ],
      }));
      expect(result.valid).toBe(true);
    });
  });

  // --- Multi-Rule AND Intersection ---
  describe("multi-rule AND intersection", () => {
    it("combines multiple rules of different types without error", () => {
      const result = evaluateSmartAlbum({
        rules: [
          { type: "dateRange", preset: "最近30天" },
          { type: "fileFormat", value: "jpg" },
          { type: "iso", operator: ">=", value: 100 },
        ],
      });
      expect(Array.isArray(result)).toBe(true);
    });

    it("returns empty when one rule has zero matches", () => {
      const result = evaluateSmartAlbum({
        rules: [
          { type: "fileFormat", value: "jpg" },
          { type: "cameraModel", operator: "等于", value: "▲▲▲NonExistentCamera▲▲▲" },
        ],
      });
      expect(result).toEqual([]);
    });
  });
});
