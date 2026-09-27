import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ReadableStream } from "node:stream/web";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPackagedExecutable,
  assertSquirrelDeltaUsed,
  downloadVerifiedAsset,
  findInstalledExecutable,
  forceKillProcessTree,
  runInstallerProcess,
  runMsiProcess,
  runPackagedE2E,
  terminateMsiProcess,
  terminatePackagedProcess,
} from "../../../scripts/windows-installer-smoke.mjs";

const fixtureRoots = new Set();
const IMMEDIATE_EXIT_ERROR_PATTERN = /exited before startup confirmation/iu;
const STALE_MARKER_ERROR_PATTERN = /fresh WHENREADY startup marker/iu;
const VERSION_MISMATCH_ERROR_PATTERN = /version mismatch/iu;
const STARTUP_FAILURE_ERROR_PATTERN = /reported startup failure/iu;
const FULL_FALLBACK_ERROR_PATTERN = /full fallback/iu;
const MISSING_DELTA_ERROR_PATTERN = /exactly one downloaded/iu;
const noOpForceKill = () => Promise.resolve();

function msiSpawnWithExit(status, recordSpawn = undefined) {
  return (command, args, options) => {
    recordSpawn?.(command, args, options);
    const child = createChild(command);
    queueMicrotask(() => {
      child.exitCode = status;
      child.emit("exit", status, null);
    });
    return child;
  };
}

describe("MSI smoke process isolation", () => {
  it.each([
    "/i",
    "/x",
  ])("keeps %s supervised without inherited I/O or Restart Manager", async (operation) => {
    let observed;
    await runMsiProcess(
      "msiexec.exe",
      [operation, "C:\\installer payload\\app.msi", "/qn", "/norestart"],
      "MSI transaction",
      undefined,
      { MSI_TEST: "yes" },
      {
        spawnProcess: msiSpawnWithExit(0, (command, args, options) => {
          observed = { command, args, options };
        }),
      }
    );
    expect(observed).toEqual({
      command: "msiexec.exe",
      args: [
        operation,
        "C:\\installer payload\\app.msi",
        "/qn",
        "/norestart",
        "REBOOT=ReallySuppress",
        "MSIRESTARTMANAGERCONTROL=Disable",
      ],
      options: {
        env: { MSI_TEST: "yes" },
        detached: false,
        stdio: "ignore",
        windowsHide: true,
      },
    });
  });

  it.each([0, 3010])("accepts completed MSI exit %i", async (status) => {
    await expect(
      runMsiProcess(
        "msiexec.exe",
        [],
        "MSI transaction",
        undefined,
        undefined,
        {
          spawnProcess: msiSpawnWithExit(status),
        }
      )
    ).resolves.toBe(status);
  });

  it.each([
    1603, 1641,
  ])("rejects MSI failure or initiated reboot %i", async (status) => {
    await expect(
      runMsiProcess(
        "msiexec.exe",
        [],
        "MSI transaction",
        undefined,
        undefined,
        {
          spawnProcess: msiSpawnWithExit(status),
        }
      )
    ).rejects.toThrow(`exit code ${status}`);
  });

  it("rejects a spawn error immediately", async () => {
    await expect(
      runMsiProcess(
        "missing.exe",
        [],
        "MSI transaction",
        undefined,
        undefined,
        {
          spawnProcess: () => {
            const child = createChild("missing.exe");
            queueMicrotask(() => child.emit("error", new Error("ENOENT")));
            return child;
          },
        }
      )
    ).rejects.toThrow("failed to start: ENOENT");
  });

  it("cleans up the timed-out child without accepting its cleanup exit as success", async () => {
    const child = createChild("msiexec.exe");
    const cleaned = [];
    await expect(
      runMsiProcess("msiexec.exe", [], "hung MSI", undefined, undefined, {
        spawnProcess: () => child,
        timeoutMs: 15,
        terminateProcess: (target) => {
          cleaned.push(target);
          target.exitCode = 0;
          target.emit("exit", 0, null);
        },
      })
    ).rejects.toThrow("hung MSI timed out after 15ms");
    expect(cleaned).toEqual([child]);
    expect(child.listenerCount("exit")).toBe(0);
  });

  it("preserves timeout failure when cleanup also fails", async () => {
    await expect(
      runMsiProcess("msiexec.exe", [], "hung MSI", undefined, undefined, {
        spawnProcess: () => createChild("msiexec.exe"),
        timeoutMs: 15,
        terminateProcess: () => {
          throw new Error("cleanup denied");
        },
      })
    ).rejects.toThrow(
      "timed out after 15ms; process cleanup failed: cleanup denied"
    );
  });

  it("kills only the active MSI tree before its parent can exit", async () => {
    const child = createChild("msiexec.exe");
    const killed = [];
    await terminateMsiProcess(child, (pid) => {
      expect(child.kills).toBe(0);
      killed.push(pid);
      child.kill();
    });
    expect(killed).toEqual(process.platform === "win32" ? [child.pid] : []);
    child.exitCode = 0;
    await terminateMsiProcess(child, () => {
      throw new Error("already exited");
    });
  });

  it("waits for the actual MSI exit after taskkill has returned", async () => {
    const child = createChild("msiexec.exe");
    child.kill = () => true;
    let settled = false;
    const cleanup = terminateMsiProcess(child, noOpForceKill, 200).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    child.exitCode = 1;
    child.emit("exit", 1, null);
    await cleanup;
    expect(settled).toBe(true);
  });

  it("fails cleanup if taskkill reports success but MSI is still alive", async () => {
    const child = createChild("msiexec.exe");
    child.kill = () => true;
    await expect(terminateMsiProcess(child, noOpForceKill, 15)).rejects.toThrow(
      "process did not exit within 15ms"
    );
  });

  it("bounds a cleanup promise that never settles and kills the client", async () => {
    const child = createChild("msiexec.exe");
    await expect(
      runMsiProcess("msiexec.exe", [], "hung cleanup", undefined, undefined, {
        spawnProcess: () => child,
        timeoutMs: 10,
        cleanupTimeoutMs: 20,
        terminateProcess: () =>
          new Promise(() => {
            // Simulate a cleanup helper that never reports completion.
          }),
      })
    ).rejects.toThrow("process cleanup exceeded 20ms");
    expect(child.kills).toBe(1);
    expect(child.exitCode).toBe(0);
    expect(child.unrefs).toBe(0);
  });

  it("fails and releases an unkillable client handle after the final deadline", async () => {
    const child = createChild("msiexec.exe");
    child.kill = () => false;
    await expect(
      runMsiProcess("msiexec.exe", [], "unkillable MSI", undefined, undefined, {
        spawnProcess: () => child,
        timeoutMs: 10,
        cleanupTimeoutMs: 15,
        terminateProcess: () => {
          throw new Error("access denied");
        },
      })
    ).rejects.toThrow("access denied; process did not exit within 15ms");
    expect(child.unrefs).toBe(1);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
  });

  it("does not treat cleanup error events as observable process exit", async () => {
    const child = createChild("msiexec.exe");
    child.kill = () => {
      queueMicrotask(() => child.emit("error", new Error("EPERM")));
      return false;
    };
    await expect(
      runMsiProcess(
        "msiexec.exe",
        [],
        "MSI error event",
        undefined,
        undefined,
        {
          spawnProcess: () => child,
          timeoutMs: 10,
          cleanupTimeoutMs: 30,
          terminateProcess: () => {
            throw new Error("tree cleanup failed");
          },
        }
      )
    ).rejects.toThrow("process exit was not observed after kill");
    expect(child.unrefs).toBe(1);
  });

  it.each([
    false,
    true,
  ])("releases timed-out taskkill (unkillable=%s) without reporting success", async (unkillable) => {
    const killer = createChild("taskkill.exe");
    if (unkillable) {
      killer.kill = () => false;
    }
    await expect(forceKillProcessTree(4242, () => killer, 15)).rejects.toThrow(
      "taskkill.exe timed out"
    );
    expect(killer.unrefs).toBe(unkillable ? 1 : 0);
    expect(killer.listenerCount("exit")).toBe(0);
    expect(killer.listenerCount("error")).toBe(0);
  });

  it("lets a real smoke supervisor exit nonzero after terminating a hung child", () => {
    const moduleUrl = pathToFileURL(
      path.resolve("scripts/windows-installer-smoke.mjs")
    ).href;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { runMsiProcess } from ${JSON.stringify(moduleUrl)};
         try {
           await runMsiProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
             "real hung child", undefined, undefined,
             { timeoutMs: 200, cleanupTimeoutMs: 1000 });
         } catch (error) {
           console.error(error.message);
           process.exitCode = 1;
         }`,
      ],
      { encoding: "utf8", timeout: 5000, windowsHide: true }
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("real hung child timed out after 200ms");
    expect(result.stdout).toContain("exited:");
  });

  it("supervises Update.exe asynchronously without adding MSI properties or inheriting runner output", async () => {
    let observed;
    await runInstallerProcess(
      "Update.exe",
      ["--update", "https://example.com/feed"],
      "MSI auto-update",
      undefined,
      undefined,
      {
        spawnProcess: msiSpawnWithExit(0, (command, args, options) => {
          observed = { command, args, options };
        }),
      }
    );
    expect(observed).toMatchObject({
      command: "Update.exe",
      args: ["--update", "https://example.com/feed"],
      options: { detached: false, stdio: "ignore", windowsHide: true },
    });
    await expect(
      runInstallerProcess(
        "Update.exe",
        [],
        "MSI auto-update",
        undefined,
        undefined,
        {
          spawnProcess: msiSpawnWithExit(3010),
        }
      )
    ).rejects.toThrow("exit code 3010");
  });

  it("captures updater output in a file without keeping a runner pipe open", async () => {
    const outputPath = path.join(
      path.dirname(createExecutable()),
      "auto-update.log"
    );
    await runInstallerProcess(
      process.execPath,
      ["-e", 'console.log("updater finished")'],
      "updater output",
      undefined,
      undefined,
      {
        outputPath,
      }
    );
    expect(fs.readFileSync(outputPath, "utf8")).toContain("updater finished");
  });
});

describe("installer baseline download deadline", () => {
  const baselineUrl = "https://example.com/previous.msi";
  const validHash = "a".repeat(64);

  it("aborts a fetch that never produces response headers", async () => {
    let signal;
    await expect(
      downloadVerifiedAsset(baselineUrl, validHash, ".msi", {
        timeoutMs: 20,
        fetchAsset: (_, options) => {
          signal = options.signal;
          return new Promise((_, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true }
            );
          });
        },
      })
    ).rejects.toThrow("Baseline download timed out after 20ms");
    expect(signal.aborted).toBe(true);
  });

  it("aborts the body pipeline after headers and releases the partial file", async () => {
    const downloadRoot = path.dirname(createExecutable());
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from("partial MSI"));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      downloadVerifiedAsset(baselineUrl, validHash, ".msi", {
        timeoutMs: 30,
        downloadRoot,
        fetchAsset: () => Promise.resolve({ ok: true, url: baselineUrl, body }),
      })
    ).rejects.toThrow("Baseline download timed out after 30ms");
    expect(cancelled).toBe(true);
    const directory = fs
      .readdirSync(downloadRoot)
      .find((name) => name.startsWith("ai-image-manager-baseline-"));
    const partialPath = path.join(downloadRoot, directory, "baseline.msi");
    // Rename preserves partial diagnostics and proves the writer released its
    // Windows file handle. Never delete a failed download's evidence here.
    fs.renameSync(partialPath, `${partialPath}.partial`);
  });

  it.each([
    true,
    false,
  ])("still enforces SHA-256 after a completed download (matches=%s)", async (matches) => {
    const bytes = Buffer.from("verified MSI bytes");
    const downloadRoot = path.dirname(createExecutable());
    const download = downloadVerifiedAsset(
      baselineUrl,
      matches ? createHash("sha256").update(bytes).digest("hex") : validHash,
      ".msi",
      {
        timeoutMs: 1000,
        downloadRoot,
        fetchAsset: () =>
          Promise.resolve({
            ok: true,
            url: baselineUrl,
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(bytes);
                controller.close();
              },
            }),
          }),
      }
    );
    if (matches) {
      expect(fs.readFileSync(await download)).toEqual(bytes);
    } else {
      await expect(download).rejects.toThrow("Baseline SHA-256 mismatch");
    }
  });
});

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
  child.unrefs = 0;
  child.unref = () => {
    child.unrefs += 1;
  };
  child.kill = () => {
    child.kills += 1;
    if (child.exitCode === null) {
      queueMicrotask(() => {
        if (child.exitCode === null) {
          child.exitCode = 0;
          child.emit("exit", 0, null);
        }
      });
    }
    return true;
  };
  return child;
}

function readinessLog(userDataDirectory) {
  return path.join(userDataDirectory, "logs", "whenReady.log");
}

function mainLog(userDataDirectory) {
  return path.join(userDataDirectory, "logs", "main.log");
}

function createMsiInstallRoot() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "ai-image-manager-msi-layout-test-")
  );
  fixtureRoots.add(root);
  fs.writeFileSync(path.join(root, "ai-image-manager.exe"), "root stub");
  for (const version of ["2.0.0", "2.1.0"]) {
    const executable = path.join(
      root,
      `app-${version}`,
      "ai-image-manager.exe"
    );
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, `real ${version}`);
  }
  return root;
}

function createSquirrelPackagesRoot(version = "2.1.0") {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "ai-image-manager-squirrel-delta-test-")
  );
  fixtureRoots.add(root);
  const packages = path.join(root, "packages");
  fs.mkdirSync(packages, { recursive: true });
  fs.writeFileSync(
    path.join(packages, `ai-image-manager-${version}-delta.nupkg`),
    "delta bytes"
  );
  return { packages, root };
}

afterEach(() => {
  for (const root of fixtureRoots) {
    fs.rmSync(root, { force: true, recursive: true });
  }
  fixtureRoots.clear();
});

describe("windows installer packaged E2E launcher", () => {
  it("confirms alive upgrade and candidate clean exit after fresh markers", async () => {
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
      mainLog(userDataDirectory),
      "old [bg] startLevel(Critical) begin\n"
    );
    let child;
    let spawnArguments;
    let appReadyMarkerWrittenWhileAlive;

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
            setTimeout(() => {
              appReadyMarkerWrittenWhileAlive = child.exitCode === null;
              fs.appendFileSync(
                mainLog(userDataDirectory),
                `app ${new Date().toISOString()} [bg] startLevel(Critical) begin\n`
              );
            }, 20);
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
    expect(appReadyMarkerWrittenWhileAlive).toBe(true);
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
    const candidateUserDataDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "ai-image-manager-e2e-user-data-")
    );
    fixtureRoots.add(candidateUserDataDirectory);
    let candidateChild;
    const candidateResult = await runPackagedE2E(
      executable,
      "candidate clean-exit packaged test app",
      candidateUserDataDirectory,
      "2.1.0",
      {
        spawnProcess: (file) => {
          candidateChild = createChild(file);
          queueMicrotask(() => {
            candidateChild.emit("spawn");
            fs.mkdirSync(
              path.dirname(readinessLog(candidateUserDataDirectory)),
              {
                recursive: true,
              }
            );
            fs.writeFileSync(
              readinessLog(candidateUserDataDirectory),
              `WHENREADY ${new Date().toISOString()}\n`
            );
            fs.writeFileSync(
              mainLog(candidateUserDataDirectory),
              `${new Date().toISOString()} [bg] startLevel(Critical) begin\n`
            );
            candidateChild.exitCode = 0;
            candidateChild.emit("exit", 0, null);
          });
          return candidateChild;
        },
        pollIntervalMs: 5,
        readyStabilityMs: 1000,
        startupTimeoutMs: 250,
        terminationTimeoutMs: 100,
        forceKill: noOpForceKill,
      }
    );
    expect(candidateResult).toBe(candidateUserDataDirectory);
    expect(candidateChild.kills).toBe(0);
  });

  it("rejects an immediate crash instead of treating spawn as readiness", async () => {
    const executable = createExecutable();
    let child;
    const userDataDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "ai-image-manager-e2e-user-data-")
    );
    fixtureRoots.add(userDataDirectory);

    await expect(
      runPackagedE2E(
        executable,
        "crashing packaged test app",
        userDataDirectory,
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
    let cleanExitChild;
    await expect(
      runPackagedE2E(
        executable,
        "unconfirmed clean-exit packaged test app",
        userDataDirectory,
        "2.1.0",
        {
          spawnProcess: (file) => {
            cleanExitChild = createChild(file);
            queueMicrotask(() => {
              cleanExitChild.emit("spawn");
              cleanExitChild.exitCode = 0;
              cleanExitChild.emit("exit", 0, null);
            });
            return cleanExitChild;
          },
          pollIntervalMs: 5,
          readyStabilityMs: 1000,
          startupTimeoutMs: 250,
          terminationTimeoutMs: 100,
          forceKill: noOpForceKill,
        }
      )
    ).rejects.toThrow(IMMEDIATE_EXIT_ERROR_PATTERN);
    expect(cleanExitChild.kills).toBe(0);
  });

  it("rejects a clean exit before the fresh main startup marker", async () => {
    const executable = createExecutable();
    const userDataDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "ai-image-manager-e2e-user-data-")
    );
    fixtureRoots.add(userDataDirectory);
    fs.mkdirSync(path.dirname(readinessLog(userDataDirectory)), {
      recursive: true,
    });
    let cleanExitChild;
    let delayedMainMarker;

    await expect(
      runPackagedE2E(
        executable,
        "early clean-exit packaged test app",
        userDataDirectory,
        "2.1.0",
        {
          spawnProcess: (file) => {
            cleanExitChild = createChild(file);
            queueMicrotask(() => {
              cleanExitChild.emit("spawn");
              fs.writeFileSync(
                readinessLog(userDataDirectory),
                `WHENREADY ${new Date().toISOString()}\n`
              );
              cleanExitChild.exitCode = 0;
              cleanExitChild.emit("exit", 0, null);
              delayedMainMarker = setTimeout(() => {
                fs.writeFileSync(
                  mainLog(userDataDirectory),
                  `${new Date().toISOString()} [bg] startLevel(Critical) begin\n`
                );
              }, 20);
            });
            return cleanExitChild;
          },
          pollIntervalMs: 5,
          readyStabilityMs: 1000,
          startupTimeoutMs: 250,
          terminationTimeoutMs: 100,
          forceKill: noOpForceKill,
        }
      )
    ).rejects.toThrow(IMMEDIATE_EXIT_ERROR_PATTERN);
    if (delayedMainMarker) {
      clearTimeout(delayedMainMarker);
    }
    expect(cleanExitChild.kills).toBe(0);
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
    fs.writeFileSync(
      mainLog(userDataDirectory),
      "old [bg] startLevel(Critical) begin\n"
    );
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
                mainLog(userDataDirectory),
                `app ${new Date().toISOString()} [bg] startLevel(Critical) begin\n`
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
                mainLog(userDataDirectory),
                `app ${new Date().toISOString()} [bg] startLevel(Critical) begin\n`
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

  it("does not taskkill a process that already exited gracefully", async () => {
    const executable = createExecutable();
    const child = createChild(executable);
    child.exitCode = 0;
    const killedPids = [];

    await terminatePackagedProcess(child, "already exited packaged app", {
      forceKill: (pid) => {
        killedPids.push(pid);
      },
    });

    expect(killedPids).toEqual([]);
    expect(child.kills).toBe(0);
  });

  it("selects the requested MSI versioned executable instead of the root stub", () => {
    const installRoot = createMsiInstallRoot();
    expect(findInstalledExecutable(installRoot, "v2.1.0")).toBe(
      path.join(installRoot, "app-2.1.0", "ai-image-manager.exe")
    );
    expect(findInstalledExecutable(installRoot, "2.0.0")).toBe(
      path.join(installRoot, "app-2.0.0", "ai-image-manager.exe")
    );
    expect(findInstalledExecutable(installRoot, "2.2.0")).toBeUndefined();
  });

  it("selects the requested executable under a custom MSI root", () => {
    const customRoot = createMsiInstallRoot();
    expect(findInstalledExecutable(customRoot, "2.1.0")).toBe(
      path.join(customRoot, "app-2.1.0", "ai-image-manager.exe")
    );
  });

  it("proves the requested Squirrel delta was retained without a full fallback", () => {
    const { root } = createSquirrelPackagesRoot();
    expect(assertSquirrelDeltaUsed(root, "v2.1.0")).toMatchObject({
      bytes: 11,
      filename: "ai-image-manager-2.1.0-delta.nupkg",
    });
  });

  it("rejects a Squirrel update that downloaded the current full fallback", () => {
    const { packages, root } = createSquirrelPackagesRoot();
    fs.writeFileSync(
      path.join(packages, "ai-image-manager-2.1.0-full.nupkg"),
      "full bytes"
    );
    expect(() => assertSquirrelDeltaUsed(root, "2.1.0")).toThrow(
      FULL_FALLBACK_ERROR_PATTERN
    );
  });

  it("rejects a Squirrel update without the expected delta package", () => {
    const { root } = createSquirrelPackagesRoot("2.0.0");
    expect(() => assertSquirrelDeltaUsed(root, "2.1.0")).toThrow(
      MISSING_DELTA_ERROR_PATTERN
    );
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
    const activeExecutable = createExecutable();
    const activeChild = createChild(activeExecutable);
    const killedPids = [];
    await terminatePackagedProcess(activeChild, "active packaged app", {
      forceKill: (pid) => {
        killedPids.push(pid);
      },
    });
    expect(activeChild.kills).toBe(1);
    expect(killedPids).toEqual(process.platform === "win32" ? [4242] : []);
  });
});
