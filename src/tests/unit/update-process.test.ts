// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
import { probeInstaller } from "@/services/update-process";

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (...args: Parameters<typeof actual.execFile>) =>
      args[0] === "powershell.exe"
        ? mocks.execFile(...args)
        : actual.execFile(...args),
  };
});
const identity = {
  installerPid: 4321,
  installerPath: "C:\\Installed\\Update.exe",
  installerCreatedAt: "123456",
};
beforeEach(() => {
  mocks.execFile.mockReset();
});
it.each([
  [identity, "matched"],
  [{ ...identity, installerCreatedAt: "999999" }, "mismatch"],
  [{ ...identity, installerPath: "C:\\Other\\Update.exe" }, "mismatch"],
  [null, "exited"],
])("checks the complete process identity: %j", async (actual, result) => {
  mocks.execFile.mockImplementation((_exe, _args, _options, callback) =>
    callback(null, JSON.stringify(actual))
  );
  expect(await probeInstaller(identity)).toBe(result);
  expect(mocks.execFile).toHaveBeenCalledWith(
    "powershell.exe",
    expect.any(Array),
    expect.objectContaining({ windowsHide: true, timeout: 5000 }),
    expect.any(Function)
  );
});
it.each([
  new Error("access denied"),
  new Error("timeout"),
])("treats failed inspection as unknown: %s", async (error) => {
  mocks.execFile.mockImplementation((_exe, _args, _options, callback) =>
    callback(error, "")
  );
  expect(await probeInstaller(identity)).toBe("unknown");
});
it("does not trust a legacy PID without creation time", async () => {
  mocks.execFile.mockImplementation((_exe, _args, _options, callback) =>
    callback(null, JSON.stringify(identity))
  );
  expect(await probeInstaller({ installerPid: 4321 })).toBe("unknown");
});
