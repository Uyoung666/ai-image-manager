import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { call } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDataPath: vi.fn(),
  registryStart: vi.fn(),
  registryStop: vi.fn(),
  setCustomDataPath: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getLoginItemSettings: () => ({ openAtLogin: false }),
    getPath: () => "C:\\AppData",
    setLoginItemSettings: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

vi.mock("@/services/registry", () => ({
  registry: {
    start: mocks.registryStart,
    stop: mocks.registryStop,
  },
}));

vi.mock("@/services/settings-manager", () => ({
  getAllSettings: vi.fn(() => ({})),
  getSetting: vi.fn(() => null),
  setSetting: vi.fn(),
}));

vi.mock("@/utils/data-path", () => ({
  getDataPath: mocks.getDataPath,
  isDefaultDataPath: vi.fn(() => true),
  setCustomDataPath: mocks.setCustomDataPath,
}));

import { setDataPath } from "@/ipc/settings/handlers";

describe("setDataPath existing library", () => {
  const oldPath = path.resolve("current-library");
  const newPath = path.resolve("previous-library");
  const databasePath = path.join(newPath, "data", "ai-image-manager.db");

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDataPath.mockReturnValue(oldPath);
    mocks.registryStop.mockResolvedValue(undefined);
    mocks.registryStart.mockResolvedValue(undefined);
    vi.spyOn(fs, "existsSync").mockImplementation(
      (candidate) => String(candidate) === newPath
    );
    vi.spyOn(fs, "statSync").mockImplementation((candidate) => {
      if (String(candidate) === databasePath) {
        return { isFile: () => true } as fs.Stats;
      }
      throw new Error("missing");
    });
    vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    vi.spyOn(fsp, "cp").mockResolvedValue(undefined);
    vi.spyOn(fsp, "rm").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("connects to an existing library without copying or deleting data", async () => {
    const result = await call(setDataPath, { newPath });

    expect(result).toMatchObject({ adopted: true, copied: 0, ok: true });
    expect(mocks.registryStop).toHaveBeenCalledOnce();
    expect(mocks.setCustomDataPath).toHaveBeenCalledWith(newPath);
    expect(mocks.registryStart).toHaveBeenCalledOnce();
    expect(fsp.cp).not.toHaveBeenCalled();
    expect(fsp.rm).not.toHaveBeenCalled();
  });

  it("restores the original library when the existing database cannot start", async () => {
    mocks.registryStart
      .mockRejectedValueOnce(new Error("database is corrupt"))
      .mockResolvedValueOnce(undefined);

    const result = await call(setDataPath, { newPath });

    expect(result).toMatchObject({ ok: false });
    expect(mocks.setCustomDataPath).toHaveBeenNthCalledWith(1, newPath);
    expect(mocks.setCustomDataPath).toHaveBeenNthCalledWith(2, oldPath);
    expect(mocks.registryStart).toHaveBeenCalledTimes(2);
    expect(fsp.cp).not.toHaveBeenCalled();
    expect(fsp.rm).not.toHaveBeenCalled();
  });
});
