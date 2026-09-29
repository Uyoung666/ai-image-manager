import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubUpdateManifest } from "@/services/github-update";

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  return {
    app: {
      getVersion: () => "2.0.0",
      isPackaged: true,
    },
    checkForUpdates: vi.fn(),
    emit(event: string, ...args: unknown[]) {
      listeners.get(event)?.(...args);
    },
    getUpdateState: vi.fn((): { phase: string; version?: string } => ({
      phase: "idle",
    })),
    listeners,
    quitAndInstall: vi.fn(),
    setFeedURL: vi.fn(),
    setUpdateState: vi.fn(),
    diagnosticLog: vi.fn(),
  };
});

vi.mock("@/services/diagnostics/logging", () => ({
  appendDiagnosticLog: mocks.diagnosticLog,
}));

vi.mock("electron", () => ({
  app: mocks.app,
  autoUpdater: {
    checkForUpdates: mocks.checkForUpdates,
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      mocks.listeners.set(event, listener);
    }),
    quitAndInstall: mocks.quitAndInstall,
    setFeedURL: mocks.setFeedURL,
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
  Notification: {
    isSupported: () => false,
  },
}));

vi.mock("@/services/settings-manager", () => ({
  getSetting: () => "true",
}));

vi.mock("@/services/update-state", () => ({
  getUpdateState: mocks.getUpdateState,
  setUpdateState: mocks.setUpdateState,
}));

const originalPlatform = process.platform;
const TEST_FEED_URL = "https://cos.example.test/updates/stable/";

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

async function loadManager(
  overrides: { feedURL?: string | null; squirrelInstallation?: boolean } = {
    feedURL: TEST_FEED_URL,
    squirrelInstallation: true,
  }
) {
  const manager = await import("@/services/update-manager");
  manager.setUpdateManagerTestOverrides(overrides);
  return manager;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  setPlatform("win32");
  mocks.app.isPackaged = true;
  mocks.checkForUpdates.mockReset();
  mocks.getUpdateState.mockReset();
  mocks.getUpdateState.mockReturnValue({ phase: "idle" });
  mocks.listeners.clear();
  mocks.quitAndInstall.mockReset();
  mocks.setFeedURL.mockReset();
  mocks.setUpdateState.mockReset();
  mocks.diagnosticLog.mockReset();
});

afterEach(() => {
  setPlatform(originalPlatform);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("update manager runtime gates and scheduling", () => {
  it("uses the injected COS stable feed and waits ten seconds before the first check", async () => {
    const manager = await loadManager();

    manager.startUpdateManager();

    expect(mocks.setFeedURL).toHaveBeenCalledWith({
      url: "https://cos.example.test/updates/stable",
    });
    expect(mocks.checkForUpdates).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(manager.UPDATE_INITIAL_DELAY_MS - 1);
    expect(mocks.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.checkForUpdates).toHaveBeenCalledOnce();
  });

  it("keeps Squirrel first-run startup on the delayed path", async () => {
    process.argv.push("--squirrel-firstrun");
    try {
      const manager = await loadManager();
      manager.startUpdateManager();

      expect(mocks.checkForUpdates).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(manager.UPDATE_INITIAL_DELAY_MS);
      expect(mocks.checkForUpdates).toHaveBeenCalledOnce();
    } finally {
      process.argv.pop();
    }
  });

  it("runs periodic checks every six hours after the delayed first check", async () => {
    const manager = await loadManager();
    manager.startUpdateManager();

    await vi.advanceTimersByTimeAsync(manager.UPDATE_INITIAL_DELAY_MS);
    expect(mocks.checkForUpdates).toHaveBeenCalledOnce();
    mocks.emit("update-not-available");

    await vi.advanceTimersByTimeAsync(manager.UPDATE_INTERVAL_MS - 1);
    expect(mocks.checkForUpdates).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("does not configure or contact a feed outside packaged Windows", async () => {
    const manager = await loadManager();
    mocks.app.isPackaged = false;

    manager.startUpdateManager();
    const result = manager.checkForUpdatesManually();

    expect(result).toEqual({ ok: false, error: "DEV_MODE" });
    expect(mocks.setFeedURL).not.toHaveBeenCalled();
    expect(mocks.checkForUpdates).not.toHaveBeenCalled();

    mocks.app.isPackaged = true;
    setPlatform("linux");
    expect(manager.checkForUpdatesManually()).toEqual({
      ok: false,
      error: "DEV_MODE",
    });
    expect(mocks.setFeedURL).not.toHaveBeenCalled();
  });

  it("directs installs without a compatible Update.exe to a manual download", async () => {
    const manager = await loadManager({
      feedURL: TEST_FEED_URL,
      squirrelInstallation: false,
    });

    manager.startUpdateManager();
    expect(manager.checkForUpdatesManually()).toEqual({
      ok: false,
      error: "UPDATE_INSTALLER_UNSUPPORTED",
    });
    expect(manager.installUpdate()).toEqual({
      ok: false,
      error: "UPDATE_INSTALLER_UNSUPPORTED",
    });
    expect(mocks.setFeedURL).not.toHaveBeenCalled();
    expect(mocks.checkForUpdates).not.toHaveBeenCalled();
    expect(mocks.quitAndInstall).not.toHaveBeenCalled();
  });
});

describe("update manager single-flight and installation", () => {
  it("coalesces checks while checking or downloading, then releases on up-to-date/error", async () => {
    const manager = await loadManager();

    expect(manager.checkForUpdatesManually()).toEqual({ ok: true });
    expect(manager.checkForUpdatesManually()).toEqual({
      ok: true,
      skipped: true,
    });
    expect(mocks.checkForUpdates).toHaveBeenCalledOnce();

    mocks.emit("update-available");
    expect(manager.checkForUpdatesManually()).toEqual({
      ok: true,
      skipped: true,
    });
    expect(mocks.checkForUpdates).toHaveBeenCalledOnce();

    mocks.emit("update-not-available");
    expect(manager.checkForUpdatesManually()).toEqual({ ok: true });
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(2);

    mocks.emit("error", new Error("ETIMEDOUT"));
    expect(manager.checkForUpdatesManually()).toEqual({ ok: true });
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(3);
  });

  it("keeps the downloaded state locked until quitAndInstall", async () => {
    const manager = await loadManager();
    manager.checkForUpdatesManually();
    mocks.emit(
      "update-downloaded",
      { type: "event" },
      "Release notes",
      "2.1.0",
      new Date("2026-08-09T00:00:00.000Z"),
      "https://cos.example.test/updates/stable"
    );

    expect(manager.checkForUpdatesManually()).toEqual({
      ok: true,
      skipped: true,
    });
    expect(manager.installUpdate()).toEqual({ ok: true });
    expect(mocks.quitAndInstall).toHaveBeenCalledOnce();
    expect(manager.checkForUpdatesManually()).toEqual({
      ok: true,
      skipped: true,
    });
    expect(mocks.checkForUpdates).toHaveBeenCalledOnce();
    expect(mocks.setUpdateState).toHaveBeenLastCalledWith({
      phase: "downloaded",
      releaseDate: "2026-08-09T00:00:00.000Z",
      releaseNotes: "Release notes",
      updateURL: "https://cos.example.test/updates/stable",
      version: "2.1.0",
    });
  });

  it("refuses to call quitAndInstall before an update is downloaded", async () => {
    const manager = await loadManager();

    expect(manager.installUpdate()).toEqual({
      ok: false,
      error: "UPDATE_NOT_READY",
    });
    expect(mocks.quitAndInstall).not.toHaveBeenCalled();
  });

  it("honors a persisted downloaded package as a lock", async () => {
    mocks.getUpdateState.mockReturnValue({
      phase: "downloaded",
      version: "2.1.0",
    });
    const manager = await loadManager();

    manager.startUpdateManager();
    expect(mocks.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(manager.UPDATE_INITIAL_DELAY_MS);
    expect(mocks.checkForUpdates).not.toHaveBeenCalled();
    expect(manager.installUpdate()).toEqual({ ok: true });
  });
});

describe("update feed source", () => {
  it("does not use a test-only source in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VITEST", "false");
    vi.stubEnv("AIM_UPDATE_BASE_URL", "");
    vi.stubEnv("AIM_UPDATE_TEST_BASE_URL", "https://test.invalid/feed");
    const manager = await loadManager({ squirrelInstallation: true });

    expect(manager.getUpdateFeedURL()).toBeNull();
    expect(manager.checkForUpdatesManually()).toEqual({
      ok: false,
      error: "UPDATE_NOT_FOUND",
    });
    expect(mocks.setFeedURL).not.toHaveBeenCalled();
    expect(mocks.checkForUpdates).not.toHaveBeenCalled();
  });

  it("rejects runtime HTTP feeds in production even when AIM_UPDATE_BASE_URL is set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VITEST", "false");
    vi.stubEnv("AIM_UPDATE_BASE_URL", "http://127.0.0.1:4173/stable");
    const manager = await loadManager({ squirrelInstallation: true });

    expect(manager.getUpdateFeedURL()).toBeNull();
    expect(mocks.setFeedURL).not.toHaveBeenCalled();
  });

  it("allows an explicit in-memory source only through the unit-test seam", async () => {
    const manager = await loadManager({
      feedURL: "http://127.0.0.1:4173/feed/",
      squirrelInstallation: true,
    });

    expect(manager.getUpdateFeedURL()).toBe("http://127.0.0.1:4173/feed");
    expect(manager.checkForUpdatesManually()).toEqual({ ok: true });
    expect(mocks.setFeedURL).toHaveBeenCalledWith({
      url: "http://127.0.0.1:4173/feed",
    });
  });
});

describe("update manager event payloads", () => {
  it("classifies .NET TLS errors, logs the full exception and releases the check lock", async () => {
    const manager = await loadManager();
    manager.checkForUpdatesManually();
    const raw = `Command failed: 4294967295 System.AggregateException: ${"�".repeat(220)} System.Net.WebException: System.IO.IOException: at System.Net.TlsStream.EndWrite`;
    mocks.emit("error", new Error(raw));
    expect(mocks.setUpdateState).toHaveBeenLastCalledWith({
      phase: "error",
      message: "UPDATE_TLS_ERROR",
    });
    expect(mocks.diagnosticLog).toHaveBeenCalledWith(
      expect.objectContaining({ message: raw, action: "update-event" })
    );
    expect(manager.checkForUpdatesManually()).toEqual({ ok: true });
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("normalizes thrown check/configuration/install failures", async () => {
    const manager = await loadManager();
    mocks.setFeedURL.mockImplementationOnce(() => {
      throw new Error("ETIMEDOUT");
    });
    expect(manager.checkForUpdatesManually()).toEqual({
      ok: false,
      error: "NETWORK_ERROR",
    });
    mocks.checkForUpdates.mockImplementationOnce(() => {
      throw new Error("unknown ����");
    });
    expect(manager.checkForUpdatesManually()).toEqual({
      ok: false,
      error: "UPDATE_UNKNOWN_ERROR",
    });
    expect(manager.checkForUpdatesManually()).toEqual({ ok: true });
    mocks.emit("update-downloaded", {}, "notes", "2.2.1");
    mocks.quitAndInstall.mockImplementationOnce(() => {
      throw new Error("Could not acquire lock");
    });
    expect(manager.installUpdate()).toEqual({
      ok: false,
      error: "UPDATE_BUSY",
    });
    expect(manager.installUpdate()).toEqual({ ok: true });
  });

  it("still reports failure and permits retry when diagnostics cannot be written", async () => {
    const manager = await loadManager();
    manager.checkForUpdatesManually();
    mocks.diagnosticLog.mockImplementation(() => {
      throw new Error("disk full");
    });
    mocks.emit("error", new Error("System.IO.IOException: disk full"));
    expect(mocks.setUpdateState).toHaveBeenLastCalledWith({
      phase: "error",
      message: "UPDATE_UNKNOWN_ERROR",
    });
    expect(manager.checkForUpdatesManually()).toEqual({ ok: true });
  });
  it("does not invent metadata for update-available and reads downloaded metadata", async () => {
    const manager = await loadManager();
    manager.checkForUpdatesManually();

    mocks.emit("update-available", { type: "event" });
    expect(mocks.setUpdateState).toHaveBeenLastCalledWith({
      phase: "downloading",
    });

    mocks.emit(
      "update-downloaded",
      { type: "event" },
      "Release notes",
      "2.1.0",
      "2026-08-09T00:00:00.000Z",
      "https://example.test/update"
    );
    expect(mocks.setUpdateState).toHaveBeenLastCalledWith({
      phase: "downloaded",
      releaseDate: "2026-08-09T00:00:00.000Z",
      releaseNotes: "Release notes",
      updateURL: "https://example.test/update",
      version: "2.1.0",
    });
  });

  it("normalizes package verification and Squirrel lock errors", async () => {
    const manager = await loadManager();
    manager.checkForUpdatesManually();

    mocks.emit(
      "error",
      new Error(
        "Checksummed file size doesn't match: packages\\ai-image-manager-2.1.0-full.nupkg"
      )
    );
    expect(mocks.setUpdateState).toHaveBeenLastCalledWith({
      message: "UPDATE_PACKAGE_CORRUPT",
      phase: "error",
    });

    manager.checkForUpdatesManually();
    mocks.emit("error", new Error("Could not acquire lock for update"));
    expect(mocks.setUpdateState).toHaveBeenLastCalledWith({
      message: "UPDATE_BUSY",
      phase: "error",
    });
  });
});

describe("local Squirrel feed preparation", () => {
  it("keeps full metadata beside a delta, then uses full-only metadata for fallback", async () => {
    const manager = await loadManager();
    const full = {
      filename: "ai-image-manager-2.2.1-full.nupkg",
      sha1: "a".repeat(40),
      sha256: "b".repeat(64),
      size: 100,
      url: "https://github.com/Uyoung666/ai-image-manager/releases/download/v2.2.1/ai-image-manager-2.2.1-full.nupkg",
    };
    const delta = {
      filename: "ai-image-manager-2.2.1-delta.nupkg",
      fromVersion: "2.2.0",
      sha1: "c".repeat(40),
      sha256: "d".repeat(64),
      size: 40,
      toVersion: "2.2.1",
      url: "https://github.com/Uyoung666/ai-image-manager/releases/download/v2.2.1/ai-image-manager-2.2.1-delta.nupkg",
    };
    const manifest = {
      assetsBaseUrl:
        "https://github.com/Uyoung666/ai-image-manager/releases/download/v2.2.1",
      packages: { delta, full },
      platform: "win32-x64",
      releaseUrl:
        "https://github.com/Uyoung666/ai-image-manager/releases/tag/v2.2.1",
      repository: "Uyoung666/ai-image-manager",
      schemaVersion: 1,
      tag: "v2.2.1",
      version: "2.2.1",
    } satisfies GitHubUpdateManifest;
    const plan = {
      currentVersion: "2.2.0",
      fallback: full,
      manifest,
      method: "delta" as const,
      package: delta,
      targetVersion: "2.2.1",
    };

    expect(manager.formatLocalReleaseFeed(plan)).toBe(
      `${full.sha1} ${full.filename} ${full.size}\n${delta.sha1} ${delta.filename} ${delta.size}\n`
    );
    expect(
      manager.formatLocalReleaseFeed({ ...plan, method: "full", package: full })
    ).toBe(`${full.sha1} ${full.filename} ${full.size}\n`);
  });
});
