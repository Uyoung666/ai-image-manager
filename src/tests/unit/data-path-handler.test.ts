/** @vitest-environment node */
import fs from "node:fs/promises";
import path from "node:path";
import { call } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, initDatabase } from "@/db";
import { setDataPath } from "@/ipc/settings/handlers";
import { getSetting, setSetting } from "@/services/settings-manager";
import { TestRuntime } from "../helpers/test-runtime";

const state = vi.hoisted(() => ({
  path: "",
  registryStart: vi.fn(),
  registryStop: vi.fn(),
  persistPath: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => state.path,
    isPackaged: false,
  },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
}));

vi.mock("@/services/registry", () => ({
  registry: { start: state.registryStart, stop: state.registryStop },
}));

vi.mock("@/utils/data-path", () => ({
  getDataPath: () => state.path,
  isDefaultDataPath: () => true,
  persistDataPath: state.persistPath,
  setRuntimeDataPath: (value: string) => {
    state.path = value;
  },
}));

let runtime: TestRuntime;
let source: string;
let destination: string;

beforeEach(() => {
  vi.resetAllMocks();
  runtime = new TestRuntime("data-path-handler");
  source = path.join(runtime.root, "original");
  destination = path.join(runtime.root, "destination");
  state.path = source;
  state.registryStop.mockImplementation(closeDatabase);
  state.registryStart.mockImplementation(initDatabase);
  setSetting("library-test", "original value");
});

afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
  expect(runtime.cleanup().status).toBe("deleted");
});

describe("explicit library directory operations", () => {
  it("creates an independent empty library, then switches back and forth", async () => {
    setSetting("onboarding.completed", "true");
    const created = await call(setDataPath, {
      mode: "create",
      newPath: destination,
    });
    expect(created).toMatchObject({ ok: true, path: destination, copied: 0 });
    expect(getSetting("library-test")).toBeNull();
    expect(getSetting("onboarding.completed")).toBeNull();
    expect(state.persistPath).toHaveBeenCalledWith(destination, true);
    setSetting("library-test", "destination value");

    expect(
      await call(setDataPath, { mode: "open", newPath: source })
    ).toMatchObject({ ok: true, path: source, copied: 0 });
    expect(getSetting("library-test")).toBe("original value");

    expect(
      await call(setDataPath, { mode: "open", newPath: destination })
    ).toMatchObject({ ok: true, path: destination });
    expect(getSetting("library-test")).toBe("destination value");
    expect(
      await call(setDataPath, { mode: "open", newPath: destination })
    ).toMatchObject({ ok: true, alreadyOpen: true });
  });

  it("copies the catalog and derived data and keeps the original by default", async () => {
    const fingerprint = path.join(source, "vectors", ".index_ready");
    await fs.mkdir(path.dirname(fingerprint));
    await fs.writeFile(fingerprint, "fixture");
    const result = await call(setDataPath, {
      mode: "migrate",
      newPath: destination,
    });
    expect(result).toMatchObject({
      ok: true,
      path: destination,
      copied: 2,
      cleaned: 0,
    });
    expect(getSetting("library-test")).toBe("original value");
    expect(
      await fs.readFile(
        path.join(destination, "vectors", ".index_ready"),
        "utf8"
      )
    ).toBe("fixture");
    expect(await fs.readFile(fingerprint, "utf8")).toBe("fixture");
    expect(
      (await fs.stat(path.join(source, "data", "ai-image-manager.db"))).isFile()
    ).toBe(true);
  });

  it("rejects non-empty and nested destinations without stopping the current library", async () => {
    await fs.mkdir(destination);
    await fs.writeFile(path.join(destination, "notes.txt"), "keep this");
    for (const mode of ["create", "migrate"] as const) {
      expect(await call(setDataPath, { mode, newPath: destination })).toEqual({
        ok: false,
        error: "notEmpty",
      });
    }
    expect(
      await call(setDataPath, {
        mode: "create",
        newPath: path.join(source, "child"),
      })
    ).toEqual({ ok: false, error: "nestedPath" });
    expect(state.registryStop).not.toHaveBeenCalled();
    expect(getSetting("library-test")).toBe("original value");
  });

  it("rejects an unreadable database without adopting or writing to it", async () => {
    const broken = path.join(destination, "data", "ai-image-manager.db");
    await fs.mkdir(path.dirname(broken), { recursive: true });
    await fs.writeFile(broken, "this is not SQLite");
    expect(
      await call(setDataPath, { mode: "open", newPath: destination })
    ).toEqual({ ok: false, error: "notLibrary" });
    expect(await fs.readFile(broken, "utf8")).toBe("this is not SQLite");
    expect(state.registryStop).not.toHaveBeenCalled();
  });

  it.each([
    "startFailed",
    "saveFailed",
  ] as const)("restores a functioning original library after %s", async (failure) => {
    const interrupted = () => {
      throw new Error("fixture failure");
    };
    if (failure === "startFailed") {
      state.registryStart.mockImplementationOnce(() => {
        initDatabase();
        interrupted();
      });
    } else {
      state.persistPath.mockImplementationOnce(interrupted);
    }
    expect(
      await call(setDataPath, { mode: "create", newPath: destination })
    ).toMatchObject({ ok: false, error: failure });
    expect(state.path).toBe(source);
    expect(getSetting("library-test")).toBe("original value");
    setSetting("library-test", "writable after rollback");
    expect(getSetting("library-test")).toBe("writable after rollback");
    expect(state.registryStop).toHaveBeenCalledTimes(2);
  });

  it("keeps the active library when stopping fails and rejects a concurrent request", async () => {
    let rejectStop!: (error: Error) => void;
    state.registryStop.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectStop = reject;
        })
    );
    const first = call(setDataPath, { mode: "create", newPath: destination });
    await vi.waitFor(() => expect(rejectStop).toBeDefined());
    expect(
      await call(setDataPath, {
        mode: "create",
        newPath: path.join(runtime.root, "other"),
      })
    ).toEqual({ error: "busy", ok: false });
    rejectStop(new Error("fixture could not stop"));
    expect(await first).toMatchObject({ error: "stopFailed", ok: false });
    expect(state.path).toBe(source);
    expect(getSetting("library-test")).toBe("original value");
    expect(state.persistPath).not.toHaveBeenCalled();
  });
});
