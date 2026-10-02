import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  _electron,
  test as base,
  type ElectronApplication,
} from "@playwright/test";
import { RUNTIME_MARKER, TestRuntime } from "../../helpers/test-runtime";

interface ManagedRuntime {
  apps: {
    app: ElectronApplication;
    child: ChildProcess;
    closed: Promise<void>;
  }[];
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
  const hook = path.join(root, "runtime-process.cjs");
  fs.writeFileSync(
    hook,
    `const fs=require('node:fs');const path=require('node:path');const marker=path.join(__dirname,${JSON.stringify(RUNTIME_MARKER)});const data=JSON.parse(fs.readFileSync(marker,'utf8'));data.childPids=[...new Set([...data.childPids,process.pid])];data.launchPending=false;fs.writeFileSync(marker,JSON.stringify(data));`
  );
  managed.runtime.setLaunchPending();
  const app = await _electron.launch({
    ...options,
    args: ["-r", hook, ...(options.args ?? [])],
  });
  const child = app.process();
  managed.runtime.trackProcess(child);
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve())
  );
  managed.apps.push({ app, child, closed });
  return app;
}

async function finishRuntime(
  managed: ManagedRuntime,
  outputDir: string
): Promise<void> {
  const { runtime, apps, diagnostics } = managed;
  for (const { app, child, closed } of apps) {
    if (child.exitCode === null && child.signalCode === null) {
      await app.close();
    }
    if (child.exitCode === null && child.signalCode === null) {
      throw new Error(`Electron did not exit: ${runtime.root}`);
    }
    await closed;
  }
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
  for (const managed of runtimes.values()) {
    try {
      await finishRuntime(managed, outputDir);
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
    { scope: "worker", auto: true },
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
