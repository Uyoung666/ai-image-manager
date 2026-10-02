/** @vitest-environment node */
import fs, { type PathLike } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupStaleRuntimes,
  isProcessAlive,
  RUNTIME_MARKER,
  TestRuntime,
} from "../helpers/test-runtime";

const managed: TestRuntime[] = [];
const protectedError = /Protected/;
const linkError = /link/;
const escapedError = /escaped|Unsupported/;

function createRuntime() {
  const runtime = new TestRuntime("runtime-unit", path.resolve(".cache"));
  managed.push(runtime);
  return runtime;
}

function updateMarker(runtime: TestRuntime, values: Record<string, unknown>) {
  const marker = path.join(runtime.root, RUNTIME_MARKER);
  const data = JSON.parse(fs.readFileSync(marker, "utf8"));
  fs.writeFileSync(marker, JSON.stringify({ ...data, ...values }));
}

function cleanupOwnedTestRuntimes(apply = false) {
  const originalRead = fs.readdirSync.bind(fs);
  const read = vi.spyOn(fs, "readdirSync").mockImplementation(((
    directory: PathLike,
    options?: never
  ) => {
    const entries = originalRead(directory, options);
    if (
      directory === path.resolve(".cache") ||
      directory === path.resolve(".test-runtime")
    ) {
      return (entries as unknown as fs.Dirent[]).filter((entry) =>
        managed.some(
          (runtime) => runtime.root === path.join(String(directory), entry.name)
        )
      );
    }
    return entries;
  }) as typeof fs.readdirSync);
  try {
    return cleanupStaleRuntimes(apply);
  } finally {
    read.mockRestore();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const runtime of managed.splice(0)) {
    if (fs.existsSync(runtime.root)) {
      updateMarker(runtime, {
        keep: false,
        childPids: [],
        launchPending: false,
      });
      expect(runtime.cleanup().status).toBe("deleted");
    }
  }
});

describe("managed test runtime cleanup", () => {
  it("records ownership and cleans generated models idempotently", () => {
    const runtime = createRuntime();
    fs.writeFileSync(path.join(runtime.root, "model.onnx"), "generated model");
    const marker = JSON.parse(
      fs.readFileSync(path.join(runtime.root, RUNTIME_MARKER), "utf8")
    );
    expect(marker).toMatchObject({
      version: 1,
      ownerPid: process.pid,
      owner: "runtime-unit",
    });
    expect(runtime.cleanup().status).toBe("deleted");
    expect(runtime.cleanup().status).toBe("deleted");
    expect(fs.existsSync(runtime.root)).toBe(false);
  });

  it("preserves requested debug runtimes", () => {
    vi.stubEnv("AIM_KEEP_TEST_RUNTIME", "1");
    const runtime = createRuntime();
    vi.unstubAllEnvs();
    expect(runtime.cleanup().status).toBe("retained");
    expect(fs.existsSync(runtime.root)).toBe(true);
  });

  it("preserves an unconfirmed launch and a running related process", () => {
    const runtime = createRuntime();
    runtime.setLaunchPending();
    expect(runtime.cleanup()).toMatchObject({
      status: "skipped",
      reason: "Unconfirmed Electron launch",
    });
    updateMarker(runtime, { launchPending: false, childPids: [process.pid] });
    expect(runtime.cleanup().status).toBe("skipped");
    expect(fs.existsSync(runtime.root)).toBe(true);
  });

  it("treats access denied as a possibly active process", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    expect(isProcessAlive(123)).toBe(true);
  });

  it("passes finite Windows lock retries and reports a persistent lock", () => {
    const runtime = createRuntime();
    const remove = vi.spyOn(fs, "rmSync").mockImplementation(() => {
      throw Object.assign(new Error("locked"), { code: "EBUSY" });
    });
    expect(() => runtime.cleanup()).toThrow("locked");
    expect(remove).toHaveBeenCalledWith(runtime.root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
    expect(fs.existsSync(runtime.root)).toBe(true);
  });

  it("rejects paths outside the registered base before removal", () => {
    expect(() => new TestRuntime("runtime-unit", path.resolve("src"))).toThrow(
      escapedError
    );
    const runtime = createRuntime();
    const actualRoot = runtime.root;
    try {
      Object.defineProperty(runtime, "root", { value: path.resolve("src") });
      expect(() => runtime.cleanup()).toThrow(escapedError);
    } finally {
      Object.defineProperty(runtime, "root", { value: actualRoot });
    }
  });

  it.each([
    "data.csv",
    "DATA.XLSX",
    "Temp",
    "linked-folder",
  ])("refuses a protected or linked entry %s using a simulated filesystem", (name) => {
    const runtime = createRuntime();
    const entry = path.join(runtime.root, name);
    const originalRead = fs.readdirSync.bind(fs);
    const originalStat = fs.lstatSync.bind(fs);
    vi.spyOn(fs, "readdirSync").mockImplementation(((
      directory: PathLike,
      options?: never
    ) => {
      if (directory === runtime.root) {
        return [RUNTIME_MARKER, name];
      }
      return originalRead(directory, options);
    }) as typeof fs.readdirSync);
    vi.spyOn(fs, "lstatSync").mockImplementation(((file: PathLike) => {
      if (file === entry) {
        return {
          isSymbolicLink: () => name === "linked-folder",
          isDirectory: () => name === "Temp",
        };
      }
      return originalStat(file);
    }) as typeof fs.lstatSync);
    const remove = vi.spyOn(fs, "rmSync");
    expect(() => runtime.cleanup()).toThrow(
      name === "linked-folder" ? linkError : protectedError
    );
    expect(remove).not.toHaveBeenCalled();
  });

  it("saves logs and diagnostics outside the runtime before deleting models", () => {
    const runtime = createRuntime();
    const destination = createRuntime();
    fs.mkdirSync(path.join(runtime.root, "profile", "diagnostics"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(runtime.root, "profile", "diagnostics", "incidents.jsonl"),
      "failure"
    );
    fs.writeFileSync(
      path.join(runtime.root, "electron.log"),
      "shutdown completed"
    );
    fs.writeFileSync(path.join(runtime.root, "model.onnx"), "model");
    runtime.saveDiagnostics(path.join(destination.root, "evidence"));
    runtime.cleanup();
    expect(
      fs.readFileSync(
        path.join(destination.root, "evidence", "electron.log"),
        "utf8"
      )
    ).toBe("shutdown completed");
    expect(
      fs.existsSync(path.join(destination.root, "evidence", "model.onnx"))
    ).toBe(false);
  });

  it("keeps the source when saving diagnostics fails", () => {
    const runtime = createRuntime();
    const destination = createRuntime();
    vi.spyOn(fs, "copyFileSync").mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() => runtime.saveDiagnostics(destination.root)).toThrow(
      "disk full"
    );
    runtime.retain();
    expect(runtime.cleanup().status).toBe("retained");
  });

  it("previews old inactive marked directories and only applies explicitly", () => {
    const runtime = createRuntime();
    updateMarker(runtime, {
      createdAt: Date.now() - 25 * 60 * 60 * 1000,
      ownerPid: 999_999_999,
    });
    expect(
      cleanupOwnedTestRuntimes().find((row) => row.root === runtime.root)
        ?.status
    ).toBe("eligible");
    expect(fs.existsSync(runtime.root)).toBe(true);
    expect(
      cleanupOwnedTestRuntimes(true).find((row) => row.root === runtime.root)
        ?.status
    ).toBe("deleted");
  });

  it("reports a stale cleanup failure and keeps its ownership marker", () => {
    const runtime = createRuntime();
    updateMarker(runtime, {
      createdAt: Date.now() - 25 * 60 * 60 * 1000,
      ownerPid: 999_999_999,
    });
    vi.spyOn(fs, "rmSync").mockImplementation(() => {
      throw Object.assign(new Error("locked"), { code: "EBUSY" });
    });
    expect(
      cleanupOwnedTestRuntimes(true).find((row) => row.root === runtime.root)
    ).toMatchObject({ status: "failed", reason: "locked" });
    expect(fs.existsSync(path.join(runtime.root, RUNTIME_MARKER))).toBe(true);
  });

  it("keeps recent, active, explicitly retained and unmarked directories", () => {
    const recent = createRuntime();
    const active = createRuntime();
    const retained = createRuntime();
    const unknown = createRuntime();
    updateMarker(active, { createdAt: Date.now() - 25 * 60 * 60 * 1000 });
    updateMarker(retained, {
      createdAt: Date.now() - 25 * 60 * 60 * 1000,
      keep: true,
    });
    const marker = path.join(unknown.root, RUNTIME_MARKER);
    const data = fs.readFileSync(marker);
    fs.unlinkSync(marker);
    const results = cleanupOwnedTestRuntimes(true);
    expect(results.find((row) => row.root === recent.root)?.status).toBe(
      "skipped"
    );
    expect(results.find((row) => row.root === active.root)?.status).toBe(
      "skipped"
    );
    expect(results.find((row) => row.root === retained.root)?.status).toBe(
      "retained"
    );
    expect(results.find((row) => row.root === unknown.root)).toBeUndefined();
    expect(fs.existsSync(unknown.root)).toBe(true);
    fs.writeFileSync(marker, data);
  });
});
