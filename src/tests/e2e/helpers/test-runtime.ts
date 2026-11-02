import { type ChildProcess, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  _electron,
  test as base,
  type ElectronApplication,
} from "@playwright/test";
import { isProcessAlive, TestRuntime } from "../../helpers/test-runtime";

interface ManagedApp {
  app: ElectronApplication;
  child: ChildProcess;
  closed: Promise<void>;
  registration: string;
}

interface ManagedRuntime {
  apps: ManagedApp[];
  diagnostics?: string;
  runtime: TestRuntime;
}

const runtimes = new Map<string, ManagedRuntime>();

export function createTestRuntime(owner: string): string {
  const runtime = new TestRuntime(owner);
  runtimes.set(runtime.root, { runtime, apps: [] });
  return runtime.root;
}

export async function launchTestApp(
  root: string,
  options: NonNullable<Parameters<typeof _electron.launch>[0]>
): Promise<ElectronApplication> {
  const managed = runtimes.get(root);
  if (!managed) {
    throw new Error(`Unregistered test runtime: ${root}`);
  }
  // Record the real PID before Playwright's launch handshake, including launches
  // that deliberately quit or fail before a window becomes available.
  const registration = managed.runtime.registerLaunch();
  const hook = `${registration}.cjs`;
  fs.writeFileSync(
    hook,
    // Each launch owns a separate record. A previous exit must never race a
    // later preload's read/modify/write of the shared ownership marker.
    `const fs = require('node:fs');
const childProcess = require('node:child_process');
const {randomUUID} = require('node:crypto');
const launchFile = ${JSON.stringify(registration)};
const childFile = pid => launchFile.slice(0, -5) + '-' + pid + '.json';
const record = (file, pid, exited) => fs.writeFileSync(file, JSON.stringify({pid, exited}));
const file = process.type === 'browser' ? launchFile : process.env.AIM_TEST_PROCESS_REGISTRATION || childFile(process.pid);
record(file, process.pid, false);
process.once('exit', () => record(file, process.pid, true));
const fork = childProcess.fork;
childProcess.fork = function(modulePath, args, options) {
  if (!Array.isArray(args)) { options = args ?? options; args = []; }
  const file = launchFile.slice(0, -5) + '-' + randomUUID() + '.json';
  const child = fork.call(this, modulePath, args, {
    ...options,
    env: {...(options?.env ?? process.env), AIM_TEST_PROCESS_REGISTRATION: file},
  });
  if (child.pid) {
    record(file, child.pid, false);
    child.once('exit', () => record(file, child.pid, true));
  }
  return child;
};
require('node:module').syncBuiltinESMExports();`
  );
  const app = await _electron.launch({
    ...options,
    args: [
      "-r",
      hook,
      // Match Windows CI instead of silently inheriting the developer's DPI.
      `--force-device-scale-factor=${process.env.AIM_E2E_DEVICE_SCALE_FACTOR ?? "1"}`,
      ...(options.args ?? []),
    ],
  });
  const child = app.process();
  // Packaged Electron ignores CLI preloads. A successful inspector handshake
  // still supplies the real main PID, independently of the cmd.exe wrapper.
  if (options.executablePath && !fs.existsSync(registration)) {
    const pid = await app.evaluate(() => process.pid);
    fs.writeFileSync(registration, JSON.stringify({ pid, exited: false }));
    app.on("close", () => {
      if (fs.existsSync(registration) && !isProcessAlive(pid)) {
        fs.writeFileSync(registration, JSON.stringify({ pid, exited: true }));
      }
    });
  }
  managed.runtime.trackProcess(child, registration);
  const closed = new Promise<void>((resolve) => {
    // Playwright launches through cmd.exe on Windows. The wrapper may already
    // have exited before the Electron launch handshake returns.
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
    } else {
      child.once("close", () => resolve());
    }
  });
  managed.apps.push({ app, child, closed, registration });
  return app;
}

function runningAppPid(registration: string): number | undefined {
  const record = JSON.parse(fs.readFileSync(registration, "utf8"));
  if (
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    typeof record.exited !== "boolean"
  ) {
    throw new Error(`Invalid Electron process registration: ${registration}`);
  }
  return !record.exited && isProcessAlive(record.pid) ? record.pid : undefined;
}

function forceCloseTestApp(owned: ManagedApp): void {
  const pid = runningAppPid(owned.registration);
  if (pid && process.platform === "win32") {
    // Verify the unique preload in the real process command line before using
    // taskkill. A stale/reused PID must never target another application.
    const hook = `${owned.registration}.cjs`.replaceAll("'", "''");
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$owned = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($owned -and $owned.CommandLine.Contains('${hook}')) { & taskkill.exe /PID ${pid} /T /F | Out-Null; if ($LASTEXITCODE -ne 0 -and (Get-Process -Id ${pid} -ErrorAction SilentlyContinue)) { throw 'Cannot terminate owned Electron process' } }`,
      ],
      { windowsHide: true, timeout: 10_000, stdio: "pipe" }
    );
  } else if (
    pid &&
    owned.child.pid === pid &&
    owned.child.exitCode === null &&
    owned.child.signalCode === null
  ) {
    process.kill(-pid, "SIGKILL");
  }
}

/** Quit the owned application and verify the real Electron PID, not cmd.exe. */
export async function closeTestApp(app: ElectronApplication): Promise<void> {
  const owned = [...runtimes.values()]
    .flatMap((managed) => managed.apps)
    .find((entry) => entry.app === app);
  if (!owned) {
    throw new Error("Cannot close an unregistered test application");
  }
  const mainPid = runningAppPid(owned.registration);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        if (mainPid) {
          await app.close();
        }
        await owned.closed;
        while (mainPid && isProcessAlive(mainPid)) {
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
        }
      })(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Electron did not exit within 15 seconds")),
          15_000
        );
      }),
    ]);
  } catch (error) {
    try {
      forceCloseTestApp(owned);
    } catch (forceError) {
      throw new AggregateError(
        [error, forceError],
        "Test app termination failed"
      );
    }
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function finishRuntime(managed: ManagedRuntime, outputDir: string): void {
  const { runtime, diagnostics } = managed;
  const destination =
    diagnostics ??
    path.join(outputDir, "runtime-diagnostics", path.basename(runtime.root));
  // Saving before deletion also covers setup failures before test fixtures start.
  runtime.saveDiagnostics(destination);
  const result = runtime.cleanup();
  if (result.status === "skipped") {
    throw new Error(`${result.reason}: ${runtime.root}`);
  }
  console.log(`[test-runtime] ${result.status}: ${runtime.root}`);
  fs.writeFileSync(
    path.join(destination, "cleanup.json"),
    JSON.stringify(result)
  );
}

async function finishWorkerRuntimes(outputDir: string): Promise<Error[]> {
  const errors: Error[] = [];
  const closeErrors = new Map<ManagedRuntime, unknown>();
  // Close every window before potentially slow Windows directory cleanup.
  // Otherwise a worker teardown deadline can leave later apps running.
  for (const managed of runtimes.values()) {
    for (const { app } of managed.apps) {
      try {
        await closeTestApp(app);
      } catch (error) {
        closeErrors.set(managed, error);
      }
    }
  }
  for (const managed of runtimes.values()) {
    try {
      if (closeErrors.has(managed)) {
        throw closeErrors.get(managed);
      }
      finishRuntime(managed, outputDir);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(
        `[test-runtime] retained: ${managed.runtime.root}: ${reason}`
      );
      try {
        managed.runtime.retain();
        managed.runtime.saveDiagnostics(
          path.join(
            outputDir,
            "runtime-diagnostics",
            path.basename(managed.runtime.root)
          )
        );
        fs.writeFileSync(
          path.join(
            outputDir,
            "runtime-diagnostics",
            path.basename(managed.runtime.root),
            "cleanup-error.json"
          ),
          JSON.stringify({ root: managed.runtime.root, reason })
        );
      } catch {
        // Keep the directory even when saving diagnostics cannot finish.
      }
      errors.push(
        new Error(`Runtime retained at ${managed.runtime.root}`, {
          cause: error,
        })
      );
    }
  }
  runtimes.clear();
  return errors;
}

export const test = base.extend<
  { runtimeDiagnostics: undefined },
  { runtimeCleanup: undefined }
>({
  runtimeCleanup: [
    async ({ playwright: _playwright }, use, workerInfo) => {
      const errors: unknown[] = [];
      try {
        await use(undefined);
      } catch (error) {
        errors.push(error);
      } finally {
        errors.push(
          ...(await finishWorkerRuntimes(workerInfo.project.outputDir))
        );
      }
      if (errors.length) {
        throw new AggregateError(errors, "Test runtime cleanup failed");
      }
    },
    { scope: "worker", auto: true, timeout: 120_000 },
  ],
  runtimeDiagnostics: [
    async ({ runtimeCleanup: _runtimeCleanup }, use, testInfo) => {
      await use(undefined);
      if (
        !["failed", "timedOut", "interrupted"].includes(testInfo.status ?? "")
      ) {
        return;
      }
      for (const managed of runtimes.values()) {
        managed.diagnostics = testInfo.outputPath(
          "runtime-diagnostics",
          path.basename(managed.runtime.root)
        );
        try {
          const saved = managed.runtime.saveDiagnostics(managed.diagnostics);
          for (const file of saved) {
            await testInfo.attach(`runtime-${path.basename(file)}`, {
              path: file,
            });
          }
        } catch (error) {
          managed.runtime.retain();
          throw error;
        }
      }
    },
    { auto: true },
  ],
});
