import { beforeEach, describe, expect, it, vi } from "vitest";

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
