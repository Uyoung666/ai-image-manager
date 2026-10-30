import path from "node:path";
import type { ResolvedForgeConfig } from "@electron-forge/shared-types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const disk = vi.hoisted(() => ({
  existing: new Set<string>(),
  copyFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: (file: string) => disk.existing.has(file),
      copyFileSync: disk.copyFileSync,
      mkdirSync: disk.mkdirSync,
      rmSync: disk.rmSync,
    },
  };
});

vi.mock("@electron-forge/plugin-vite", () => ({
  VitePlugin: class {},
}));

vi.mock("../../services/model-downloader", () => ({
  MODEL_MANIFEST: [
    { fileName: "required.onnx", subPath: "active", required: true },
    { fileName: "optional.json", subPath: "active", required: false },
    {
      fileName: "excluded.onnx",
      subPath: "experimental",
      required: true,
      bundled: false,
    },
  ],
}));

async function loadConfig() {
  return (await import("../../../forge.config")).default;
}

async function preparePackage() {
  const config = await loadConfig();
  const hook = config.hooks?.prePackage;
  if (typeof hook !== "function") {
    throw new Error("Missing prePackage hook");
  }
  await hook(config as ResolvedForgeConfig, "win32", "x64");
}

describe("release model staging lifecycle", () => {
  it("moves only the maker phase away from Unicode temporary paths", async () => {
    if (process.platform !== "win32") {
      return;
    }
    vi.stubEnv("TEMP", "C:\\Users\\测试\\Temp");
    vi.stubEnv("TMP", "C:\\Users\\测试\\Temp");
    try {
      const config = await loadConfig();
      expect(process.env.TEMP).toBe("C:\\Users\\测试\\Temp");
      const hook = config.hooks?.preMake;
      expect(typeof hook).toBe("function");
      await (hook as () => Promise<void>)();
      expect(process.env.TEMP).toBe(
        path.resolve(".test-runtime/forge-distribution")
      );
      expect(process.env.TMP).toBe(process.env.TEMP);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    disk.existing.clear();
  });

  // The first import loads Forge makers and can exceed 5s on Windows.
  it("loads the configuration without models or filesystem writes", async () => {
    await expect(loadConfig()).resolves.toHaveProperty(
      "rebuildConfig.force",
      true
    );
    expect(disk.rmSync).not.toHaveBeenCalled();
    expect(disk.mkdirSync).not.toHaveBeenCalled();
    expect(disk.copyFileSync).not.toHaveBeenCalled();
  }, 15_000);

  it("cleans caches before staging only bundled models for packaging", async () => {
    const caches = [
      path.join("node_modules", "@xenova", "transformers", ".cache"),
      path.join("node_modules", "@huggingface", ".cache"),
    ];
    const source = path.join("models", "active", "required.onnx");
    for (const file of [...caches, source]) {
      disk.existing.add(file);
    }
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    try {
      await preparePackage();
      expect(disk.rmSync.mock.calls.map(([file]) => file)).toEqual([
        ...caches,
        path.resolve("models-release"),
      ]);
      expect(disk.copyFileSync).toHaveBeenCalledExactlyOnceWith(
        source,
        path.resolve("models-release", "active", "required.onnx")
      );
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("skipped optional model")
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("fails packaging when a required model is missing", async () => {
    await expect(preparePackage()).rejects.toThrow(
      `Required release model is missing: ${path.join("models", "active", "required.onnx")}`
    );
    expect(disk.copyFileSync).not.toHaveBeenCalled();
  });
});
