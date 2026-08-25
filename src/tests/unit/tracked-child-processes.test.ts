import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getTrackedChildProcessCount,
  terminateTrackedChildProcesses,
  trackChildProcess,
} from "@/services/tracked-child-processes";

class FakeChildProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn(() => {
    this.signalCode = "SIGTERM";
    this.emit("exit", null, "SIGTERM");
    return true;
  });
}

afterEach(async () => {
  await terminateTrackedChildProcesses(0);
});

describe("tracked child processes", () => {
  it("removes a worker from tracking when it exits normally", () => {
    const child = trackChildProcess(
      new FakeChildProcess() as unknown as import("node:child_process").ChildProcess
    );

    expect(getTrackedChildProcessCount()).toBe(1);
    child.emit("exit", 0, null);
    expect(getTrackedChildProcessCount()).toBe(0);
  });

  it("terminates and waits for every tracked worker", async () => {
    const first = new FakeChildProcess();
    const second = new FakeChildProcess();
    trackChildProcess(
      first as unknown as import("node:child_process").ChildProcess
    );
    trackChildProcess(
      second as unknown as import("node:child_process").ChildProcess
    );

    await terminateTrackedChildProcesses();

    expect(first.kill).toHaveBeenCalledOnce();
    expect(second.kill).toHaveBeenCalledOnce();
    expect(getTrackedChildProcessCount()).toBe(0);
  });
});
