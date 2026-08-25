import type { ChildProcess } from "node:child_process";

const trackedChildren = new Set<ChildProcess>();

/**
 * Track every worker forked from the Electron main process.
 *
 * On Windows, child processes are not automatically terminated when their
 * parent exits. A surviving ELECTRON_RUN_AS_NODE worker still has the packaged
 * executable and native DLLs mapped, so Windows Installer reports the whole
 * application as running even after its window and tray icon have disappeared.
 */
export function trackChildProcess<T extends ChildProcess>(child: T): T {
  trackedChildren.add(child);
  child.on("exit", () => {
    trackedChildren.delete(child);
  });
  return child;
}

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

export function terminateTrackedChildProcessesSync(): void {
  for (const child of trackedChildren) {
    if (!isRunning(child)) {
      trackedChildren.delete(child);
      continue;
    }
    try {
      child.kill();
    } catch {
      // The process may already have exited between the state check and kill.
    }
  }
}

/** Terminate tracked workers and briefly wait for Windows to release images. */
export async function terminateTrackedChildProcesses(
  timeoutMs = 1500
): Promise<void> {
  terminateTrackedChildProcessesSync();
  const deadline = Date.now() + timeoutMs;

  while ([...trackedChildren].some(isRunning) && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }

  // A second kill is intentional: it covers a worker that was busy in native
  // inference code and did not react to the first termination request promptly.
  terminateTrackedChildProcessesSync();
}

export function getTrackedChildProcessCount(): number {
  return [...trackedChildren].filter(isRunning).length;
}
