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
  releaseCache: null as
    | import("@/services/update-state").ReleaseListCache
    | null,
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

vi.mock("@/services/update-package-transport", () => ({
  fetchUpdatePackage: (url: string, headers: unknown, signal: AbortSignal) =>
    mocks.fetch(url, { headers, signal }),
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
  getReleaseListCache: () => mocks.releaseCache,
  setReleaseListCache: (
    value: import("@/services/update-state").ReleaseListCache
  ) => {
    mocks.releaseCache = value;
  },
  isReleaseListEntry: (value: unknown) =>
    Boolean(
      value &&
        typeof value === "object" &&
        "tag_name" in value &&
        typeof value.tag_name === "string"
    ),
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
  mocks.releaseCache = null;
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
afterEach(async () => {
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
  // Allow pending filesystem close callbacks to run between Windows lock retries.
  await vi.waitFor(() => expect(runtime.cleanup().status).toBe("deleted"), {
    timeout: 5000,
  });
});

async function download() {
  expect(manager.checkForUpdatesManually().ok).toBe(true);
  await vi.waitFor(() => expect(mocks.state.phase).toBe("downloaded"));
}

function metadataResponse(
  status: number,
  value: unknown,
  headers: Record<string, string> = {}
) {
  const request = Object.assign(new EventEmitter(), {
    setHeader: vi.fn(),
    abort: vi.fn(),
    followRedirect: vi.fn(),
    end() {
      queueMicrotask(() => {
        const response = Object.assign(new EventEmitter(), {
          statusCode: status,
          headers,
        });
        request.emit("response", response);
        response.emit("data", Buffer.from(JSON.stringify(value)));
        response.emit("end");
      });
    },
  });
  return request;
}

async function reloadManager() {
  manager.stopAutomaticChecks();
  vi.resetModules();
  manager = await import("@/services/update-manager");
}

describe("release list cache and downloaded cache recovery", () => {
  it("compares cached releases after 304 when the update cache has disappeared", async () => {
    mocks.request.mockImplementationOnce(() =>
      metadataResponse(200, [{ tag_name: "v2.2.4", body: null }], {
        etag: "releases-v1",
      })
    );
    await download();
    const directory = path.join(mocks.profile, "updates", "github", "2.2.4");
    await fs.unlink(path.join(directory, "update-manifest.json"));
    await fs.unlink(path.join(directory, "RELEASES"));
    await fs.unlink(path.join(directory, manifest.packages.delta.filename));
    await reloadManager();
    const request = metadataResponse(304, null);
    mocks.request.mockImplementationOnce(() => request);
    await download();
    expect(request.setHeader).toHaveBeenCalledWith(
      "If-None-Match",
      "releases-v1"
    );
    expect(mocks.state.version).toBe("2.2.4");
    expect(mocks.state.releaseNotes).toBeUndefined();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("ignores a legacy ETag without a release list and retries an unsolicited 304 once", async () => {
    mocks.state = { phase: "idle", etag: "legacy" };
    const request = metadataResponse(304, null);
    mocks.request.mockImplementationOnce(() => request);
    await download();
    expect(request.setHeader).not.toHaveBeenCalledWith(
      "If-None-Match",
      expect.anything()
    );
    expect(mocks.request).toHaveBeenCalledTimes(3);
  });

  it("retains the same transaction budget and full selection when its manifest is lost", async () => {
    mocks.state = {
      phase: "downloaded",
      version: "2.2.4",
      updateMethod: "full",
      transactionId: "same-target",
      cacheRepairs: { delta: true, full: true },
      fullFallbackAttempted: true,
    };
    await download();
    expect(mocks.state).toMatchObject({
      transactionId: "same-target",
      updateMethod: "full",
      cacheRepairs: { delta: true, full: true },
      fullFallbackAttempted: true,
    });
    expect(mocks.fetch.mock.calls[0][0]).toBe(manifest.packages.full.url);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("retains a repair budget even if fetching the replacement manifest fails", async () => {
    mocks.state = {
      phase: "downloaded",
      version: "2.2.4",
      updateMethod: "full",
      transactionId: "same-target",
      cacheRepairs: { full: true },
      fullFallbackAttempted: true,
    };
    mocks.request
      .mockImplementationOnce(() =>
        metadataResponse(200, [{ tag_name: "v2.2.4" }])
      )
      .mockImplementationOnce(() => metadataResponse(404, {}));
    manager.checkForUpdatesManually();
    await vi.waitFor(() =>
      expect(mocks.state).toMatchObject({
        phase: "error",
        transactionId: "same-target",
        cacheRepairs: { full: true },
      })
    );
    await download();
    expect(mocks.state).toMatchObject({
      transactionId: "same-target",
      updateMethod: "full",
      cacheRepairs: { full: true },
      fullFallbackAttempted: true,
    });
  });

  it("persists repair budgets while replacement metadata is still in flight", async () => {
    mocks.state = {
      phase: "downloaded",
      version: "2.2.4",
      updateMethod: "full",
      transactionId: "checking-target",
      cacheRepairs: { delta: true, full: true },
      fullFallbackAttempted: true,
      resumeInstallation: true,
    };
    const request = Object.assign(new EventEmitter(), {
      setHeader: vi.fn(),
      abort: vi.fn(),
      end: vi.fn(),
    });
    mocks.request.mockImplementationOnce(() => request);
    manager.checkForUpdatesManually();
    const interrupted = { ...mocks.state };
    expect(interrupted).toMatchObject({
      phase: "checking",
      version: "2.2.4",
      transactionId: "checking-target",
      cacheRepairs: { delta: true, full: true },
      fullFallbackAttempted: true,
      resumeInstallation: true,
    });
    request.emit("error", new Error("ECONNRESET"));
    await vi.waitFor(() => expect(mocks.state.phase).toBe("error"));
    mocks.state = interrupted;
    await reloadManager();
    manager.startUpdateManager();
    expect(mocks.state).toMatchObject({
      phase: "error",
      transactionId: "checking-target",
      cacheRepairs: { delta: true, full: true },
      fullFallbackAttempted: true,
      resumeInstallation: true,
    });
    manager.checkForUpdatesManually();
    await vi.waitFor(() => expect(mocks.state.phase).toBe("restarting"));
    expect(mocks.state).toMatchObject({
      transactionId: "checking-target",
      cacheRepairs: { delta: true, full: true },
      fullFallbackAttempted: true,
    });
  });

  it("continues confirmed installation after explicitly retrying with a missing manifest", async () => {
    mocks.state = {
      phase: "error",
      operation: "check",
      version: "2.2.4",
      updateMethod: "full",
      transactionId: "confirmed-target",
      cacheRepairs: { full: true },
      resumeInstallation: true,
    };
    manager.checkForUpdatesManually();
    await vi.waitFor(() => expect(mocks.state.phase).toBe("restarting"));
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.state).toMatchObject({
      transactionId: "confirmed-target",
      updateMethod: "full",
      cacheRepairs: { full: true },
    });
  });

  it("does not install during background metadata recovery, even with a saved install intent", async () => {
    vi.useFakeTimers();
    mocks.state = {
      phase: "error",
      operation: "check",
      version: "2.2.4",
      updateMethod: "full",
      transactionId: "background-target",
      resumeInstallation: true,
      cacheRepairs: { full: true },
    };
    manager.startUpdateManager();
    await vi.advanceTimersByTimeAsync(manager.UPDATE_INITIAL_DELAY_MS);
    await vi.waitFor(() => expect(mocks.state.phase).toBe("downloaded"));
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.state).toMatchObject({
      resumeInstallation: true,
      cacheRepairs: { full: true },
    });
  });

  it("reports repeated 304 without a cache as a failure", async () => {
    mocks.request.mockImplementation(() => metadataResponse(304, null));
    manager.checkForUpdatesManually();
    await vi.waitFor(() => expect(mocks.state.phase).toBe("error"));
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(mocks.state.lastCheckResult).not.toBe("up-to-date");
  });

  it("retries manifest retrieval using the cached release list after an earlier failure", async () => {
    mocks.request
      .mockImplementationOnce(() =>
        metadataResponse(200, [{ tag_name: "v2.2.4" }], { etag: "list" })
      )
      .mockImplementationOnce(() => metadataResponse(404, {}));
    manager.checkForUpdatesManually();
    await vi.waitFor(() => expect(mocks.state.phase).toBe("error"));
    mocks.request.mockImplementationOnce(() => metadataResponse(304, null));
    await download();
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it("accepts an empty release list and its subsequent 304", async () => {
    mocks.request.mockImplementationOnce(() =>
      metadataResponse(200, [], { etag: "empty" })
    );
    manager.checkForUpdatesManually();
    await vi.waitFor(() => expect(mocks.state.phase).toBe("up-to-date"));
    mocks.request.mockImplementationOnce(() => metadataResponse(304, null));
    manager.checkForUpdatesManually();
    await vi.waitFor(() => expect(mocks.state.phase).toBe("up-to-date"));
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([
    "delta",
    "full",
  ] as const)("repairs damaged %s bytes before installing exactly once", async (method) => {
    if (method === "full") {
      mocks.version = "2.2.2";
    }
    await download();
    const info = manifest.packages[method];
    await fs.writeFile(
      path.join(mocks.profile, "updates", "github", "2.2.4", info.filename),
      "broken"
    );
    expect(manager.installUpdate().ok).toBe(true);
    expect(manager.installUpdate()).toEqual({ ok: true, skipped: true });
    await vi.waitFor(() => expect(mocks.relaunch).toHaveBeenCalledOnce());
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(mocks.state.cacheRepairs?.[method]).toBe(true);
    expect(mocks.state.recoveryReason).toBe("cache-corrupt");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("restores a missing package from its manifest without automatically installing", async () => {
    await download();
    await fs.unlink(
      path.join(
        mocks.profile,
        "updates",
        "github",
        "2.2.4",
        manifest.packages.delta.filename
      )
    );
    await reloadManager();
    manager.startUpdateManager();
    expect(mocks.state).toMatchObject({
      phase: "error",
      canResume: true,
      recoveryReason: "cache-missing",
    });
    manager.resumeUpdateDownload();
    await vi.waitFor(() => expect(mocks.state.phase).toBe("downloaded"));
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("falls back to full once when a repaired delta is still corrupt", async () => {
    await download();
    await fs.writeFile(
      path.join(
        mocks.profile,
        "updates",
        "github",
        "2.2.4",
        manifest.packages.delta.filename
      ),
      "broken"
    );
    mocks.fetch.mockImplementation(
      async (url: string) =>
        new Response(
          url.includes("delta") ? Buffer.alloc(deltaBytes.length, 1) : fullBytes
        )
    );
    manager.installUpdate();
    await vi.waitFor(() => expect(mocks.relaunch).toHaveBeenCalledOnce());
    expect(mocks.state).toMatchObject({
      updateMethod: "full",
      fullFallbackAttempted: true,
      cacheRepairs: { delta: true },
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(4);
  });

  it("preserves the repair budget and install intent across a failed repair and process restart", async () => {
    await download();
    await fs.writeFile(
      path.join(
        mocks.profile,
        "updates",
        "github",
        "2.2.4",
        manifest.packages.delta.filename
      ),
      "broken"
    );
    mocks.fetch.mockRejectedValue(new Error("EACCES"));
    manager.installUpdate();
    await vi.waitFor(() =>
      expect(mocks.state).toMatchObject({
        phase: "error",
        canResume: true,
        cacheRepairs: { delta: true },
      })
    );
    expect(mocks.state.resumeInstallation).toBe(true);
    await reloadManager();
    vi.useFakeTimers();
    manager.startUpdateManager();
    expect(mocks.state.cacheRepairs).toEqual({ delta: true });
    const calls = mocks.fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.fetch).toHaveBeenCalledTimes(calls);
    vi.useRealTimers();
    await vi.waitFor(() =>
      expect(manager.checkForUpdatesManually().ok).toBe(true)
    );
    // Explicit retry starts another round; the periodic timer alone never does.
    await vi.waitFor(() =>
      expect(mocks.fetch.mock.calls.length).toBeGreaterThan(calls)
    );
    await vi.waitFor(() => expect(mocks.state.phase).toBe("error"));
    mocks.fetch.mockImplementation(async () => new Response(deltaBytes));
    manager.resumeUpdateDownload();
    await vi.waitFor(() => expect(mocks.relaunch).toHaveBeenCalledOnce());
  });

  it("stops after a corrupted full fallback and allows an explicit retry", async () => {
    await download();
    await fs.unlink(
      path.join(
        mocks.profile,
        "updates",
        "github",
        "2.2.4",
        manifest.packages.delta.filename
      )
    );
    mocks.fetch.mockImplementation(
      async (url: string) =>
        new Response(
          Buffer.alloc(
            url.includes("delta") ? deltaBytes.length : fullBytes.length,
            1
          )
        )
    );
    manager.installUpdate();
    await vi.waitFor(() =>
      expect(mocks.state).toMatchObject({
        phase: "error",
        canResume: true,
        updateMethod: "full",
        fullFallbackAttempted: true,
      })
    );
    expect(mocks.fetch).toHaveBeenCalledTimes(5);
    expect(mocks.spawn).not.toHaveBeenCalled();
    mocks.fetch.mockImplementation(async () => new Response(fullBytes));
    manager.resumeUpdateDownload();
    await vi.waitFor(() => expect(mocks.relaunch).toHaveBeenCalledOnce());
  });

  it("does not renew an exhausted persisted repair budget until explicit retry", async () => {
    await download();
    mocks.state.cacheRepairs = { delta: true };
    await fs.writeFile(
      path.join(
        mocks.profile,
        "updates",
        "github",
        "2.2.4",
        manifest.packages.delta.filename
      ),
      "broken"
    );
    await reloadManager();
    manager.startUpdateManager();
    manager.installUpdate();
    await vi.waitFor(() =>
      expect(mocks.state).toMatchObject({ phase: "error", canResume: true })
    );
    expect(mocks.fetch).toHaveBeenCalledOnce();
    manager.resumeUpdateDownload();
    await vi.waitFor(() => expect(mocks.relaunch).toHaveBeenCalledOnce());
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps the task resumable when preflight detects insufficient download space", async () => {
    const space = vi
      .spyOn(fs, "statfs")
      .mockResolvedValue({ bavail: 1n, bsize: 1n } as Awaited<
        ReturnType<typeof fs.statfs>
      >);
    try {
      manager.checkForUpdatesManually();
      await vi.waitFor(() =>
        expect(mocks.state).toMatchObject({
          phase: "error",
          message: "UPDATE_DISK_SPACE",
          canResume: true,
          updateMethod: "delta",
        })
      );
      expect(mocks.fetch).not.toHaveBeenCalled();
    } finally {
      space.mockRestore();
    }
    manager.resumeUpdateDownload();
    await vi.waitFor(() => expect(mocks.state.phase).toBe("downloaded"));
  });

  it("reports disk exhaustion during the download without retrying or switching packages", async () => {
    mocks.fetch.mockRejectedValue(new Error("ENOSPC"));
    manager.checkForUpdatesManually();
    await vi.waitFor(() =>
      expect(mocks.state).toMatchObject({
        phase: "error",
        message: "UPDATE_DISK_SPACE",
        canResume: true,
        updateMethod: "delta",
      })
    );
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("does not launch the installer or download full when installation space is insufficient", async () => {
    await download();
    const space = vi
      .spyOn(fs, "statfs")
      .mockResolvedValue({ bavail: 1n, bsize: 1n } as Awaited<
        ReturnType<typeof fs.statfs>
      >);
    try {
      manager.installUpdate();
      await vi.waitFor(() =>
        expect(mocks.state).toMatchObject({
          phase: "error",
          message: "UPDATE_DISK_SPACE",
          operation: "install",
        })
      );
      expect(mocks.fetch).toHaveBeenCalledOnce();
      expect(mocks.spawn).not.toHaveBeenCalled();
    } finally {
      space.mockRestore();
    }
    manager.installUpdate();
    await vi.waitFor(() => expect(mocks.relaunch).toHaveBeenCalledOnce());
  });
});

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
