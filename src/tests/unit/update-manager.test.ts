import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  return {
    emit(event: string, ...args: unknown[]) {
      listeners.get(event)?.(...args);
    },
    listeners,
    setUpdateState: vi.fn(),
  };
});

vi.mock("electron", () => ({
  app: {
    getVersion: () => "2.0.0",
    isPackaged: true,
  },
  autoUpdater: {
    checkForUpdates: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      mocks.listeners.set(event, listener);
    }),
    quitAndInstall: vi.fn(),
    setFeedURL: vi.fn(),
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
  getUpdateState: () => ({ phase: "idle" }),
  setUpdateState: mocks.setUpdateState,
}));

import {
  startUpdateManager,
  stopAutomaticChecks,
} from "@/services/update-manager";

beforeAll(() => {
  startUpdateManager();
});

afterAll(() => {
  stopAutomaticChecks();
});

afterEach(() => {
  mocks.setUpdateState.mockClear();
});

describe("update manager autoUpdater event payloads", () => {
  it("does not invent metadata for update-available", () => {
    mocks.emit("update-available", { type: "event" });

    expect(mocks.setUpdateState).toHaveBeenLastCalledWith({
      phase: "downloading",
    });
  });

  it("reads downloaded metadata after the event argument", () => {
    mocks.emit(
      "update-downloaded",
      { type: "event" },
      "Release notes",
      "1.5.0",
      "2026-08-09T00:00:00.000Z",
      "https://example.test/update"
    );

    expect(mocks.setUpdateState).toHaveBeenLastCalledWith({
      phase: "downloaded",
      releaseDate: "2026-08-09T00:00:00.000Z",
      releaseNotes: "Release notes",
      updateURL: "https://example.test/update",
      version: "1.5.0",
    });
  });
});
