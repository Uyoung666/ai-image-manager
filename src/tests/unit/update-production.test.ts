// @vitest-environment node
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "@/types/update";
import { TestRuntime } from "../helpers/test-runtime";

const mocks = vi.hoisted(() => ({
  state: { phase: "idle" } as UpdateStatus,
  profile: "",
  version: "2.2.3",
  fetch: vi.fn(),
  request: vi.fn(),
  spawn: vi.fn(),
  relaunch: vi.fn(),
  quit: vi.fn(),
  send: vi.fn(),
  log: vi.fn(),
}));
vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getPath: () => mocks.profile,
    getVersion: () => mocks.version,
    relaunch: mocks.relaunch,
    quit: mocks.quit,
  },
  net: { request: mocks.request, fetch: mocks.fetch },
  autoUpdater: {},
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        isVisible: () => true,
        webContents: { send: mocks.send },
      },
    ],
  },
  Notification: { isSupported: () => false },
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("@/services/settings-manager", () => ({ getSetting: () => "true" }));
vi.mock("@/services/diagnostics/logging", () => ({
  appendDiagnosticLog: mocks.log,
}));
vi.mock("@/services/update-state", () => ({
  getUpdateState: () => ({ ...mocks.state }),
  setUpdateState: (next: UpdateStatus) => {
    mocks.state = { ...next };
  },
}));

const deltaBytes = Buffer.from("delta package");
const fullBytes = Buffer.from("complete application package");
function pkg(method: "delta" | "full", bytes: Buffer) {
  return {
    filename: `ai-image-manager-2.2.4-${method}.nupkg`,
    size: bytes.length,
    sha1: createHash("sha1").update(bytes).digest("hex"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    url: `https://github.com/Uyoung666/ai-image-manager/releases/download/v2.2.4/ai-image-manager-2.2.4-${method}.nupkg`,
    ...(method === "delta" ? { fromVersion: "2.2.3", toVersion: "2.2.4" } : {}),
  };
}
const manifest = {
  schemaVersion: 1,
  repository: "Uyoung666/ai-image-manager",
  platform: "win32-x64",
  version: "2.2.4",
  tag: "v2.2.4",
  assetsBaseUrl:
    "https://github.com/Uyoung666/ai-image-manager/releases/download/v2.2.4",
  releaseUrl:
    "https://github.com/Uyoung666/ai-image-manager/releases/tag/v2.2.4",
  packages: { delta: pkg("delta", deltaBytes), full: pkg("full", fullBytes) },
};
let runtime: TestRuntime;
let originalExecutable: string;
let originalPlatform: string;
let manager: typeof import("@/services/update-manager");

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.state = { phase: "idle" };
  mocks.version = "2.2.3";
  runtime = new TestRuntime("update-production");
  mocks.profile = path.join(runtime.root, "profile");
  originalExecutable = process.execPath;
  originalPlatform = process.platform;
  Object.defineProperty(process, "execPath", {
    configurable: true,
    value: path.join(runtime.root, "app-2.2.3", "ai-image-manager.exe"),
  });
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: "win32",
  });
  await fs.writeFile(path.join(runtime.root, "Update.exe"), "test updater");
  await fs.mkdir(path.join(runtime.root, "app-2.2.4"));
  await fs.writeFile(
    path.join(runtime.root, "app-2.2.4", "ai-image-manager.exe"),
    "target executable"
  );
  vi.stubGlobal(
    "__AIM_UPDATE_BASE_URL__",
    "https://github.com/Uyoung666/ai-image-manager/releases"
  );
  mocks.request.mockImplementation(({ url }: { url: string }) => {
    const request = Object.assign(new EventEmitter(), {
      setHeader: vi.fn(),
      abort: vi.fn(),
      followRedirect: vi.fn(),
      end: () => {
        queueMicrotask(() => {
          const response = Object.assign(new EventEmitter(), {
            statusCode: 200,
            headers: {},
          });
          request.emit("response", response);
          response.emit(
            "data",
            Buffer.from(
              JSON.stringify(
                url.includes("api.github.com")
                  ? [{ tag_name: "v2.2.4", body: "notes" }]
                  : manifest
              )
            )
          );
          response.emit("end");
        });
      },
    });
    return request;
  });
  mocks.fetch.mockImplementation(
    async (url: string) =>
      new Response(url.includes("delta") ? deltaBytes : fullBytes)
  );
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  });
  manager = await import("@/services/update-manager");
  // Do not setUpdateManagerTestOverrides: exercise the production GitHub path.
});
afterEach(() => {
  manager.stopAutomaticChecks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(process, "execPath", {
    configurable: true,
    value: originalExecutable,
  });
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: originalPlatform,
  });
  runtime.cleanup();
});

async function download() {
  expect(manager.checkForUpdatesManually().ok).toBe(true);
  await vi.waitFor(() => expect(mocks.state.phase).toBe("downloaded"));
}

describe("GitHub download, local installer and restart transaction", () => {
  it("installs delta and explicitly relaunches the target executable once", async () => {
    await download();
    expect(mocks.state.updateMethod).toBe("delta");
    expect(manager.installUpdate().ok).toBe(true);
    expect(manager.installUpdate()).toEqual({ ok: true, skipped: true });
    await vi.waitFor(() => expect(mocks.relaunch).toHaveBeenCalledOnce());
    expect(mocks.relaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        execPath: path.join(runtime.root, "app-2.2.4", "ai-image-manager.exe"),
      })
    );
    expect(mocks.state.phase).toBe("restarting");
    expect(mocks.state.installCompletedAt).toBeTruthy();
    expect(mocks.state.percent).toBeUndefined();
    expect(mocks.spawn).toHaveBeenCalledOnce();
  });
  it("automatically falls back only when the delta asset is missing", async () => {
    mocks.fetch.mockImplementation(async (url: string) =>
      url.includes("delta")
        ? new Response(null, { status: 404 })
        : new Response(fullBytes)
    );
    await download();
    expect(mocks.state.updateMethod).toBe("full");
    expect(mocks.state.fallbackReason).toBe("delta-missing");
    manager.installUpdate();
    await vi.waitFor(() => expect(mocks.relaunch).toHaveBeenCalledOnce());
  });
  it("retains delta after exhausted network retries and permits explicit full selection", async () => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "setInterval",
        "clearTimeout",
        "clearInterval",
        "Date",
      ],
    });
    mocks.fetch.mockRejectedValue(new Error("net::ERR_NETWORK_CHANGED"));
    manager.checkForUpdatesManually();
    for (const [attempt, delay] of [
      [1, 2000],
      [2, 5000],
      [3, 15_000],
    ]) {
      await vi.waitFor(() =>
        expect(mocks.state).toMatchObject({ phase: "retry-wait", attempt })
      );
      await vi.advanceTimersByTimeAsync(delay);
    }
    await vi.waitFor(() =>
      expect(mocks.state).toMatchObject({
        phase: "error",
        updateMethod: "delta",
        canResume: true,
        canUseFull: true,
      })
    );
    expect(
      mocks.fetch.mock.calls.every(
        ([url]) => url === manifest.packages.delta.url
      )
    ).toBe(true);
    mocks.fetch.mockImplementation(async () => new Response(fullBytes));
    expect(manager.resumeUpdateDownload(true).ok).toBe(true);
    await vi.waitFor(() =>
      expect(mocks.state).toMatchObject({
        phase: "downloaded",
        updateMethod: "full",
        fallbackReason: "user-selected",
      })
    );
  });
  it.each([
    "unknown installer error",
    "delta failed: unknown installer error",
    "Failed to apply delta patch: System.UnauthorizedAccessException: 拒绝访问",
    "Failed to apply delta patch: 磁盘空间不足 (0x80070070)",
    "Failed to apply delta patch: net::ERR_NETWORK_CHANGED",
    "Failed to apply delta patch: ERR_CERT_AUTHORITY_INVALID",
    "ENOSPC",
    "EACCES",
    "another instance mutex",
  ])("does not download full after %s", async (failure) => {
    await download();
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        child.stderr.emit("data", Buffer.from(failure));
        child.emit("exit", 1);
      });
      return child;
    });
    manager.installUpdate();
    await vi.waitFor(() => expect(mocks.state.phase).toBe("error"));
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });
  it("resumes installation after a patch failure and an interrupted full download", async () => {
    await download();
    mocks.spawn.mockImplementationOnce(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        child.stderr.emit("data", Buffer.from("Failed to apply delta patch"));
        child.emit("exit", 1);
      });
      return child;
    });
    mocks.fetch.mockRejectedValue(new Error("EACCES"));
    manager.installUpdate();
    await vi.waitFor(() =>
      expect(mocks.state).toMatchObject({
        phase: "error",
        operation: "download",
        canResume: true,
        resumeInstallation: true,
      })
    );
    expect(mocks.relaunch).not.toHaveBeenCalled();
    mocks.fetch.mockImplementation(async () => new Response(fullBytes));
    manager.resumeUpdateDownload();
    await vi.waitFor(() => expect(mocks.relaunch).toHaveBeenCalledOnce());
    expect(mocks.state.updateMethod).toBe("full");
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });
  it("keeps a live recovered installer locked until the bounded recovery expires", async () => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "setInterval",
        "clearTimeout",
        "clearInterval",
        "Date",
      ],
    });
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      mocks.state = {
        phase: "installing",
        version: "2.2.4",
        installerPid: 123_456,
      };
      manager.startUpdateManager();
      expect(manager.isUpdateInstallationActive()).toBe(true);
      expect(manager.installUpdate()).toEqual({
        ok: false,
        error: "UPDATE_BUSY",
      });
      await vi.advanceTimersByTimeAsync(15 * 60_000 + 2000);
      expect(mocks.state).toMatchObject({
        phase: "error",
        message: "UPDATE_INSTALL_TIMEOUT",
      });
      expect(manager.isUpdateInstallationActive()).toBe(true);
      expect(manager.resumeUpdateDownload().ok).toBe(false);
      expect(mocks.spawn).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });
  it("rejects an automatic launch with a mismatched transaction token", () => {
    process.argv.push("--aim-update-token=wrong-token");
    try {
      mocks.version = "2.2.4";
      Object.defineProperty(process, "execPath", {
        configurable: true,
        value: path.join(runtime.root, "app-2.2.4", "ai-image-manager.exe"),
      });
      mocks.state = {
        phase: "restarting",
        version: "2.2.4",
        relaunchToken: "expected-token",
        installCompletedAt: new Date().toISOString(),
      };
      manager.startUpdateManager();
      expect(mocks.state.phase).toBe("error");
      expect(mocks.relaunch).not.toHaveBeenCalled();
    } finally {
      process.argv.pop();
    }
  });
  it("does not lock a stale checking state", async () => {
    mocks.state = { phase: "checking" };
    await download();
  });
  it("restores a partial download after process restart", async () => {
    const directory = path.join(mocks.profile, "updates", "github", "2.2.4");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, "update-manifest.json"),
      JSON.stringify(manifest)
    );
    await fs.writeFile(
      path.join(directory, `${manifest.packages.delta.filename}.download`),
      deltaBytes.subarray(0, 3)
    );
    mocks.state = {
      phase: "downloading",
      version: "2.2.4",
      updateMethod: "delta",
      operation: "download",
    };
    mocks.fetch.mockResolvedValue(
      new Response(deltaBytes.subarray(3), {
        status: 206,
        headers: {
          "content-range": `bytes 3-${deltaBytes.length - 1}/${deltaBytes.length}`,
        },
      })
    );
    manager.startUpdateManager();
    expect(mocks.state).toMatchObject({ phase: "error", canResume: true });
    manager.resumeUpdateDownload();
    await vi.waitFor(() => expect(mocks.state.phase).toBe("downloaded"));
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("confirms a manually launched installed target without a relaunch token", () => {
    mocks.version = "2.2.4";
    Object.defineProperty(process, "execPath", {
      configurable: true,
      value: path.join(runtime.root, "app-2.2.4", "ai-image-manager.exe"),
    });
    mocks.state = {
      phase: "restarting",
      version: "2.2.4",
      relaunchToken: "previous-automatic-token",
      installCompletedAt: new Date().toISOString(),
    };
    manager.startUpdateManager();
    expect(mocks.state.phase).toBe("idle");
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });
  it("does not mistake a target directory for a completed installation", () => {
    mocks.state = { phase: "installing", version: "2.2.4" };
    manager.startUpdateManager();
    expect(mocks.state).toMatchObject({
      phase: "error",
      message: "UPDATE_INSTALL_INTERRUPTED",
    });
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });
  it("bounds automatic relaunch attempts", () => {
    mocks.state = { phase: "restarting", version: "2.2.4", restartAttempts: 2 };
    manager.startUpdateManager();
    expect(mocks.state).toMatchObject({
      phase: "error",
      message: "UPDATE_RESTART_REQUIRED",
    });
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });
});
