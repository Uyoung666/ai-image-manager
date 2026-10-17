import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), log: vi.fn() }));
vi.mock("electron-store", () => ({
  default: class {
    get = mocks.get;
    set = mocks.set;
  },
}));
vi.mock("@/services/diagnostics/logging", () => ({
  appendDiagnosticLog: mocks.log,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("durable update state", () => {
  it("keeps progress live in memory and merges disk writes to two-second intervals", async () => {
    vi.useFakeTimers();
    const { setUpdateState, getUpdateState } = await import(
      "@/services/update-state"
    );
    setUpdateState({ phase: "downloading", version: "2.2.4", percent: 0 });
    for (let percent = 1; percent <= 7; percent++) {
      vi.advanceTimersByTime(250);
      setUpdateState({ phase: "downloading", version: "2.2.4", percent });
    }
    expect(getUpdateState().percent).toBe(7);
    expect(mocks.set).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(250);
    expect(mocks.set).toHaveBeenCalledTimes(2);
    expect(mocks.set).toHaveBeenLastCalledWith(
      "state",
      expect.objectContaining({ percent: 7 })
    );
  });

  it("persists recovery budgets and terminal states immediately without a stale timer overwrite", async () => {
    vi.useFakeTimers();
    const { setUpdateState } = await import("@/services/update-state");
    setUpdateState({ phase: "downloading", percent: 0 });
    setUpdateState({ phase: "downloading", percent: 10 });
    setUpdateState({
      phase: "downloading",
      percent: 10,
      cacheRepairs: { delta: true },
    });
    expect(mocks.set).toHaveBeenCalledTimes(2);
    setUpdateState({
      phase: "downloading",
      percent: 20,
      cacheRepairs: { delta: true },
    });
    setUpdateState({
      phase: "downloaded",
      percent: 100,
      cacheRepairs: { delta: true },
    });
    vi.advanceTimersByTime(10_000);
    expect(mocks.set).toHaveBeenCalledTimes(3);
    expect(mocks.set).toHaveBeenLastCalledWith(
      "state",
      expect.objectContaining({ phase: "downloaded" })
    );
  });

  it("rejects malformed release caches and retains valid empty lists", async () => {
    const { getReleaseListCache, setReleaseListCache } = await import(
      "@/services/update-state"
    );
    for (const value of [
      { etag: "old" },
      { etag: 42, releases: [] },
      { releases: [null] },
      { releases: [{}] },
      { releases: [{ draft: "false" }] },
    ]) {
      mocks.get.mockReturnValue(value);
      expect(getReleaseListCache()).toBeNull();
    }
    mocks.get.mockReturnValue({ etag: "empty", releases: [] });
    expect(getReleaseListCache()).toEqual({ etag: "empty", releases: [] });
    const withoutNotes = {
      etag: "no-notes",
      releases: [{ tag_name: "v2.2.4", body: null }],
    };
    mocks.get.mockReturnValue(withoutNotes);
    expect(getReleaseListCache()).toEqual(withoutNotes);
    setReleaseListCache({ etag: "list", releases: [{ tag_name: "v2.2.4" }] });
    expect(mocks.set).toHaveBeenLastCalledWith(
      "releaseCache",
      expect.objectContaining({ etag: "list" })
    );
    const entry = {
      tag_name: "v2.2.4",
      assets: [{ unused: "large API payload" }],
    };
    setReleaseListCache({ etag: "compact", releases: [entry] });
    expect(mocks.set.mock.lastCall?.[1].releases[0]).not.toHaveProperty(
      "assets"
    );
  });
});

describe("cached update errors", () => {
  it("normalizes legacy output once and logs the original through diagnostics", async () => {
    const message =
      "System.Net.WebException: ���� at System.Net.TlsStream.EndWrite";
    mocks.get.mockReturnValue({ phase: "error", message });
    const { getUpdateState } = await import("@/services/update-state");
    expect(getUpdateState()).toEqual({
      phase: "error",
      message: "UPDATE_TLS_ERROR",
    });
    getUpdateState();
    expect(mocks.log).toHaveBeenCalledOnce();
    expect(mocks.log).toHaveBeenCalledWith(
      expect.objectContaining({ message, action: "restore-status" })
    );
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("leaves completion reconciliation to the update manager", async () => {
    mocks.get.mockReturnValue({ phase: "downloaded", version: "2.2.1" });
    const { getUpdateState } = await import("@/services/update-state");
    expect(getUpdateState()).toEqual({ phase: "downloaded", version: "2.2.1" });
    expect(mocks.set).not.toHaveBeenCalled();
  });
});
