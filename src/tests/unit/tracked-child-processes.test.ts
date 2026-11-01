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
  it("terminates a worker registered after quit cleanup has started", async () => {
    vi.resetModules();
    const lifecycle = await import("@/services/tracked-child-processes");
    lifecycle.beginChildProcessShutdown();
    const late = new FakeChildProcess();
    lifecycle.trackChildProcess(
      late as unknown as import("node:child_process").ChildProcess
    );
    expect(late.kill).toHaveBeenCalledOnce();
    expect(lifecycle.getTrackedChildProcessCount()).toBe(0);
  });

  it("keeps a late worker visible if termination initially fails", async () => {
    vi.resetModules();
    const lifecycle = await import("@/services/tracked-child-processes");
    lifecycle.beginChildProcessShutdown();
    const late = new FakeChildProcess();
    late.kill.mockImplementationOnce(() => false);
    lifecycle.trackChildProcess(
      late as unknown as import("node:child_process").ChildProcess
    );
    expect(lifecycle.getTrackedChildProcessCount()).toBe(1);
    await lifecycle.terminateTrackedChildProcesses();
    expect(late.kill).toHaveBeenCalledTimes(2);
    expect(lifecycle.getTrackedChildProcessCount()).toBe(0);
  });

  it("catches a replacement forked while an existing worker exits", async () => {
    vi.resetModules();
    const lifecycle = await import("@/services/tracked-child-processes");
    const first = new FakeChildProcess();
    const replacement = new FakeChildProcess();
    lifecycle.trackChildProcess(
      first as unknown as import("node:child_process").ChildProcess
    );
    first.on("exit", () =>
      lifecycle.trackChildProcess(
        replacement as unknown as import("node:child_process").ChildProcess
      )
    );
    lifecycle.beginChildProcessShutdown();
    await lifecycle.terminateTrackedChildProcesses();
    expect(replacement.kill).toHaveBeenCalledOnce();
    expect(lifecycle.getTrackedChildProcessCount()).toBe(0);
  });
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
