import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUpdateUiStore } from "@/hooks/use-update-ui";
import { updateUiFixture } from "../helpers/update-ui";

vi.mock("@/ipc/manager", () => ({ ipc: { client: {} } }));
let stop: (() => void) | undefined;
beforeEach(() => localStorage.clear());
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.restoreAllMocks();
});

async function started(fixture = updateUiFixture()) {
  stop = fixture.store.start();
  await waitFor(() =>
    expect(fixture.store.getSnapshot().preferencesReady).toBe(true)
  );
  return fixture;
}

describe("shared update renderer store", () => {
  it("starts only one subscription and never lets a late snapshot overwrite an event", async () => {
    const fixture = updateUiFixture();
    let finish: (value: { phase: "idle" }) => void = () => undefined;
    fixture.dependencies.getStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const add = vi.spyOn(window, "addEventListener");
    await started(fixture);
    const secondStop = fixture.store.start();
    fixture.emit({ phase: "downloading", version: "2.2.4", percent: 42 });
    finish({ phase: "idle" });
    await Promise.resolve();
    expect(fixture.store.getSnapshot().status.phase).toBe("downloading");
    expect(fixture.dependencies.getStatus).toHaveBeenCalledOnce();
    expect(
      add.mock.calls.filter(([event]) => event === "message")
    ).toHaveLength(1);
    secondStop();
  });

  it("keeps background progress quiet and claims a ready notice only once per version across restarts", async () => {
    const fixture = await started();
    fixture.emit({ phase: "downloading", version: "2.2.4", percent: 42 });
    fixture.emit({ phase: "retry-wait", version: "2.2.4" });
    expect(fixture.store.getSnapshot().notice).toBeNull();
    fixture.emit({ phase: "downloaded", version: "2.2.4" });
    const notice = fixture.store.getSnapshot().notice;
    expect(notice).toMatchObject({ kind: "ready", version: "2.2.4" });
    fixture.emit({ phase: "downloaded", version: "2.2.4", percent: 100 });
    expect(fixture.store.getSnapshot().notice).toBe(notice);
    stop?.();
    const next = await started(
      updateUiFixture({ phase: "downloaded", version: "2.2.4" })
    );
    expect(next.store.getSnapshot().notice).toBeNull();
    next.emit({ phase: "downloaded", version: "2.2.5" });
    expect(next.store.getSnapshot().notice).toMatchObject({ version: "2.2.5" });
  });

  it("ignores an older snapshot when a newer refresh completes first", async () => {
    const fixture = updateUiFixture();
    let finish: (value: { phase: "idle" }) => void = () => undefined;
    fixture.dependencies.getStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await started(fixture);
    fixture.setServerStatus({ phase: "installing", version: "2.2.4" });
    await fixture.store.refreshStatus();
    finish({ phase: "idle" });
    await Promise.resolve();
    expect(fixture.store.getSnapshot().status).toMatchObject({
      phase: "installing",
      version: "2.2.4",
    });
  });

  it("retains in-memory notice deduplication when storage cannot be read or written", async () => {
    const fixture = updateUiFixture();
    fixture.dependencies.storage.mockImplementation(() => {
      throw new Error("blocked");
    });
    await started(fixture);
    fixture.emit({ phase: "downloaded", version: "2.2.4" });
    fixture.emit({ phase: "installing", version: "2.2.4" });
    fixture.emit({ phase: "downloaded", version: "2.2.4" });
    expect(fixture.store.getSnapshot().notice).toBeNull();
  });

  it("does not mistake a repaired package awaiting automatic installation for a user-ready update", async () => {
    const fixture = await started();
    fixture.emit({
      phase: "downloaded",
      version: "2.2.4",
      resumeInstallation: true,
    });
    expect(fixture.store.getSnapshot().notice).toBeNull();
  });

  it("respects disabled reminders, then sends the first ready notice when re-enabled", async () => {
    const fixture = updateUiFixture();
    fixture.dependencies.getPreferences.mockResolvedValue({
      updateAutoUpdate: true,
      updateReminder: false,
    });
    await started(fixture);
    fixture.emit({ phase: "downloaded", version: "2.2.4" });
    expect(fixture.store.getSnapshot().notice).toBeNull();
    await fixture.store.setPreference("reminder", true);
    expect(fixture.store.getSnapshot().notice).toMatchObject({ kind: "ready" });
  });

  it("keeps background errors quiet with reminders off but reports a confirmed installation failure", async () => {
    const fixture = updateUiFixture();
    fixture.dependencies.getPreferences.mockResolvedValue({
      updateAutoUpdate: true,
      updateReminder: false,
    });
    await started(fixture);
    fixture.emit({
      phase: "error",
      message: "NETWORK_ERROR",
      operation: "download",
      canResume: true,
    });
    expect(fixture.store.getSnapshot().notice).toBeNull();
    fixture.emit({
      phase: "installing",
      operation: "install",
      version: "2.2.4",
    });
    fixture.emit({
      phase: "error",
      message: "UPDATE_INSTALL_DISK_FULL",
      operation: "install",
      version: "2.2.4",
    });
    const notice = fixture.store.getSnapshot().notice;
    expect(notice).toMatchObject({
      kind: "error",
      error: "UPDATE_INSTALL_DISK_FULL",
    });
    fixture.emit({
      phase: "error",
      message: "UPDATE_INSTALL_DISK_FULL",
      operation: "install",
      version: "2.2.4",
      transferred: 100,
    });
    expect(fixture.store.getSnapshot().notice).toBe(notice);
  });

  it("shares a command lock and refreshes skipped results without inventing a main-process phase", async () => {
    const fixture = await started(
      updateUiFixture({ phase: "downloaded", version: "2.2.4" })
    );
    let finish: (value: { ok: true; skipped: true }) => void = () => undefined;
    fixture.dependencies.install.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const first = fixture.store.run("install");
    expect(fixture.store.getSnapshot()).toMatchObject({
      pending: "install",
      status: { phase: "downloaded" },
    });
    await expect(fixture.store.run("install")).resolves.toEqual({
      ok: true,
      skipped: true,
    });
    expect(fixture.dependencies.install).toHaveBeenCalledOnce();
    fixture.setServerStatus({ phase: "installing", version: "2.2.4" });
    finish({ ok: true, skipped: true });
    await first;
    expect(fixture.store.getSnapshot()).toMatchObject({
      pending: null,
      status: { phase: "installing" },
    });
    expect(fixture.dependencies.getStatus).toHaveBeenCalledTimes(2);
  });

  it("localizes rejected commands and releases the shared lock", async () => {
    const fixture = await started();
    fixture.dependencies.check.mockRejectedValueOnce(
      new Error("System.Net.TlsStream.EndWrite")
    );
    await expect(fixture.store.run("check")).resolves.toEqual({
      ok: false,
      error: "UPDATE_TLS_ERROR",
    });
    expect(fixture.store.getSnapshot()).toMatchObject({
      pending: null,
      commandError: "UPDATE_TLS_ERROR",
      failedCommand: "check",
    });
  });

  it("rolls failed preference writes back and exposes feedback", async () => {
    const fixture = await started();
    fixture.dependencies.savePreference.mockRejectedValueOnce(
      new Error("denied")
    );
    await fixture.store.setPreference("autoUpdate", false);
    expect(fixture.store.getSnapshot()).toMatchObject({
      autoUpdate: true,
      preferenceError: true,
      preferencesPending: false,
    });
  });

  it("does not rerender a notice-only subscriber on each progress event", async () => {
    const fixture = updateUiFixture();
    let renders = 0;
    const { useUpdateUi } = await import("@/hooks/use-update-ui");
    function NoticeSubscriber() {
      useUpdateUi((value) => value.notice);
      renders++;
      return null;
    }
    fixture.render(<NoticeSubscriber />);
    await waitFor(() =>
      expect(fixture.store.getSnapshot().preferencesReady).toBe(true)
    );
    const before = renders;
    act(() => {
      for (let percent = 0; percent < 10; percent++) {
        fixture.emit({ phase: "downloading", percent });
      }
    });
    expect(renders).toBe(before);
    expect(createUpdateUiStore).toBeTypeOf("function");
  });
});
