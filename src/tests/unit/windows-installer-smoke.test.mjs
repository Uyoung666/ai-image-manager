import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPackagedExecutable,
  forceKillProcessTree,
  runPackagedE2E,
  terminatePackagedProcess,
} from "../../../scripts/windows-installer-smoke.mjs";

const fixtureRoots = new Set();
const IMMEDIATE_EXIT_ERROR_PATTERN = /exited before startup confirmation/iu;
const STALE_MARKER_ERROR_PATTERN = /fresh WHENREADY startup marker/iu;
const VERSION_MISMATCH_ERROR_PATTERN = /version mismatch/iu;
const STARTUP_FAILURE_ERROR_PATTERN = /reported startup failure/iu;
const noOpForceKill = () => Promise.resolve();

function createExecutable(version = "2.1.0") {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "ai-image-manager-installer-smoke-test-")
  );
  fixtureRoots.add(root);
  const executable = path.join(root, `app-${version}`, "ai-image-manager.exe");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, "test executable");
  return executable;
}

function createChild(executable) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.spawnfile = executable;
  child.kills = 0;
  child.kill = () => {
    child.kills += 1;
    if (child.exitCode === null) {
      child.exitCode = 0;
      queueMicrotask(() => child.emit("exit", 0, null));
    }
    return true;
  };
  return child;
}

function readinessLog(userDataDirectory) {
  return path.join(userDataDirectory, "logs", "whenReady.log");
}

function appLog(userDataDirectory) {
  return path.join(userDataDirectory, "logs", "app.log");
}

afterEach(() => {
  for (const root of fixtureRoots) {
    fs.rmSync(root, { force: true, recursive: true });
  }
  fixtureRoots.clear();
});

describe("windows installer packaged E2E launcher", () => {
  it("confirms a fresh ready marker, validates identity, and stops the GUI", async () => {
    const executable = createExecutable();
    const userDataDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "ai-image-manager-e2e-user-data-")
    );
    fixtureRoots.add(userDataDirectory);
    fs.mkdirSync(path.dirname(readinessLog(userDataDirectory)), {
      recursive: true,
    });
    fs.writeFileSync(readinessLog(userDataDirectory), "WHENREADY stale\n");
    fs.writeFileSync(
      appLog(userDataDirectory),
      "old Window ready — starting background services...\n"
    );
    let child;
    let spawnArguments;

    const result = await runPackagedE2E(
      executable,
      "launch packaged test app",
      userDataDirectory,
      "2.1.0",
      {
        spawnProcess: (file, args, options) => {
          child = createChild(file);
          spawnArguments = { file, args, options };
          queueMicrotask(() => {
            child.emit("spawn");
            fs.writeFileSync(
              readinessLog(userDataDirectory),
              `WHENREADY ${new Date().toISOString()}\n`
            );
            fs.appendFileSync(
              appLog(userDataDirectory),
              `app ${new Date().toISOString()} Window ready — starting background services...\n`
            );
          });
          return child;
        },
        pollIntervalMs: 5,
        readyStabilityMs: 10,
        startupTimeoutMs: 250,
        terminationTimeoutMs: 100,
        forceKill: noOpForceKill,
      }
    );

    expect(result).toBe(userDataDirectory);
    expect(child.kills).toBe(1);
    expect(spawnArguments).toMatchObject({
      file: executable,
      args: ["--e2e", "--e2e-quit-after-ready"],
      options: {
        stdio: "ignore",
        windowsHide: true,
        env: expect.objectContaining({
          AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: userDataDirectory,
          CI: "e2e",
        }),
      },
    });
  });

  it("rejects an immediate crash instead of treating spawn as readiness", async () => {
    const executable = createExecutable();
    let child;

    await expect(
      runPackagedE2E(
        executable,
        "crashing packaged test app",
        undefined,
        "2.1.0",
        {
          spawnProcess: (file) => {
            child = createChild(file);
            queueMicrotask(() => {
              child.emit("spawn");
              child.exitCode = 1;
              child.emit("exit", 1, null);
            });
            return child;
          },
          pollIntervalMs: 5,
          readyStabilityMs: 10,
          startupTimeoutMs: 250,
          terminationTimeoutMs: 100,
          forceKill: noOpForceKill,
        }
      )
    ).rejects.toThrow(IMMEDIATE_EXIT_ERROR_PATTERN);
    expect(child.kills).toBe(0);
  });

  it("does not accept a stale readiness marker", async () => {
    const executable = createExecutable();
    const userDataDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "ai-image-manager-e2e-user-data-")
    );
    fixtureRoots.add(userDataDirectory);
    fs.mkdirSync(path.dirname(readinessLog(userDataDirectory)), {
      recursive: true,
    });
    fs.writeFileSync(readinessLog(userDataDirectory), "WHENREADY old run\n");
    let child;

    await expect(
      runPackagedE2E(
        executable,
        "stale packaged test app",
        userDataDirectory,
        "2.1.0",
        {
          spawnProcess: (file) => {
            child = createChild(file);
            queueMicrotask(() => child.emit("spawn"));
            return child;
          },
          pollIntervalMs: 5,
          readyStabilityMs: 10,
          startupTimeoutMs: 40,
          terminationTimeoutMs: 100,
          forceKill: noOpForceKill,
        }
      )
    ).rejects.toThrow(STALE_MARKER_ERROR_PATTERN);
    expect(child.kills).toBe(1);
  });

  it("rejects a startup failure marker and executable version mismatch", async () => {
    const executable = createExecutable("2.0.0");
    expect(() => assertPackagedExecutable(executable, "2.1.0")).toThrow(
      VERSION_MISMATCH_ERROR_PATTERN
    );

    const matchingExecutable = createExecutable("2.1.0");
    const userDataDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "ai-image-manager-e2e-user-data-")
    );
    fixtureRoots.add(userDataDirectory);
    let child;
    await expect(
      runPackagedE2E(
        matchingExecutable,
        "failed packaged test app",
        userDataDirectory,
        "2.1.0",
        {
          spawnProcess: (file) => {
            child = createChild(file);
            queueMicrotask(() => {
              child.emit("spawn");
              fs.mkdirSync(path.dirname(readinessLog(userDataDirectory)), {
                recursive: true,
              });
              fs.writeFileSync(readinessLog(userDataDirectory), "CATCH boom\n");
            });
            return child;
          },
          pollIntervalMs: 5,
          readyStabilityMs: 10,
          startupTimeoutMs: 250,
          terminationTimeoutMs: 100,
          forceKill: noOpForceKill,
        }
      )
    ).rejects.toThrow(STARTUP_FAILURE_ERROR_PATTERN);
    expect(child.kills).toBe(1);
  });
  it("keeps observing after late app initialization and catches delayed CATCH", async () => {
    const executable = createExecutable();
    const userDataDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "ai-image-manager-e2e-user-data-")
    );
    fixtureRoots.add(userDataDirectory);
    fs.mkdirSync(path.dirname(readinessLog(userDataDirectory)), {
      recursive: true,
    });
    let child;
    let delayedTimer;

    await expect(
      runPackagedE2E(
        executable,
        "late-failing packaged test app",
        userDataDirectory,
        "2.1.0",
        {
          spawnProcess: (file) => {
            child = createChild(file);
            queueMicrotask(() => {
              child.emit("spawn");
              fs.writeFileSync(
                readinessLog(userDataDirectory),
                `WHENREADY ${new Date().toISOString()}\n`
              );
              fs.writeFileSync(
                appLog(userDataDirectory),
                `app ${new Date().toISOString()} Window ready — starting background services...\n`
              );
              delayedTimer = setTimeout(() => {
                fs.writeFileSync(
                  readinessLog(userDataDirectory),
                  "CATCH delayed startup failure\n"
                );
              }, 650);
            });
            return child;
          },
          pollIntervalMs: 5,
          readyStabilityMs: 1000,
          startupTimeoutMs: 1500,
          terminationTimeoutMs: 100,
          forceKill: noOpForceKill,
        }
      )
    ).rejects.toThrow(STARTUP_FAILURE_ERROR_PATTERN);
    if (delayedTimer) {
      clearTimeout(delayedTimer);
    }
    expect(child.kills).toBe(1);
  });

  it("retries temporary readiness-log read errors until startup succeeds", async () => {
    const executable = createExecutable();
    const userDataDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "ai-image-manager-e2e-user-data-")
    );
    fixtureRoots.add(userDataDirectory);
    fs.mkdirSync(path.dirname(readinessLog(userDataDirectory)), {
      recursive: true,
    });
    fs.mkdirSync(readinessLog(userDataDirectory));
    let child;
    let repairTimer;

    const result = await runPackagedE2E(
      executable,
      "temporarily unreadable packaged test app",
      userDataDirectory,
      "2.1.0",
      {
        spawnProcess: (file) => {
          child = createChild(file);
          queueMicrotask(() => {
            child.emit("spawn");
            repairTimer = setTimeout(() => {
              fs.renameSync(
                readinessLog(userDataDirectory),
                `${readinessLog(userDataDirectory)}.unreadable`
              );
              fs.writeFileSync(
                readinessLog(userDataDirectory),
                `WHENREADY ${new Date().toISOString()}\n`
              );
              fs.writeFileSync(
                appLog(userDataDirectory),
                `app ${new Date().toISOString()} Window ready — starting background services...\n`
              );
            }, 30);
          });
          return child;
        },
        pollIntervalMs: 5,
        readyStabilityMs: 10,
        startupTimeoutMs: 300,
        terminationTimeoutMs: 100,
        forceKill: noOpForceKill,
      }
    );
    if (repairTimer) {
      clearTimeout(repairTimer);
    }
    expect(result).toBe(userDataDirectory);
    expect(child.kills).toBe(1);
  });

  it("force-cleans the process tree even when the parent already exited", async () => {
    const executable = createExecutable();
    const child = createChild(executable);
    child.exitCode = 0;
    const killedPids = [];

    await terminatePackagedProcess(child, "already exited packaged app", {
      forceKill: (pid) => {
        killedPids.push(pid);
      },
    });

    expect(killedPids).toEqual([4242]);
    expect(child.kills).toBe(0);
  });

  it("handles taskkill spawn errors and exit events without listener races", async () => {
    await expect(
      forceKillProcessTree(4242, () => {
        throw new Error("taskkill spawn failed");
      })
    ).rejects.toThrow("taskkill spawn failed");

    const killer = new EventEmitter();
    killer.exitCode = null;
    killer.signalCode = null;
    const stopped = forceKillProcessTree(4242, () => {
      queueMicrotask(() => {
        killer.exitCode = 0;
        killer.emit("exit", 0, null);
      });
      return killer;
    });
    await expect(stopped).resolves.toBeUndefined();
  });
});
