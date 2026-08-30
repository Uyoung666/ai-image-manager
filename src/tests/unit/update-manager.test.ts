import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  };
});

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
});
