import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

const packagedExecutable = process.env.AIM_PACKAGED_E2E_EXECUTABLE;
const TRACKED_WORKER_LOG_PATTERN = /quit-cleanup: TRACKED_WORKERS=[1-9]\d*/;
test.setTimeout(120_000);

function listPackagedProcessIds(): number[] {
  const output = execFileSync(
    "tasklist.exe",
    ["/FI", "IMAGENAME eq ai-image-manager.exe", "/FO", "CSV", "/NH"],
    { encoding: "utf8", windowsHide: true }
  );
  return [...output.matchAll(/"[^"]+","(\d+)"/g)].map((match) =>
    Number(match[1])
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

test("packaged quit releases the main process and every worker", async () => {
  test.skip(
    process.platform !== "win32" || !packagedExecutable,
    "requires a packaged Windows executable"
  );
  if (!packagedExecutable) {
    throw new Error("AIM_PACKAGED_E2E_EXECUTABLE is required");
  }
  const testRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "ai-image-manager-e2e-quit-")
  );
  const userDataDirectory = path.join(testRoot, "user-data");
  const baselinePids = new Set(listPackagedProcessIds());
  const observedPids = new Set<number>();
  let appProcess: ChildProcess | undefined;

  try {
    appProcess = spawn(
      path.resolve(packagedExecutable),
      [
        "--disable-gpu-sandbox",
        "--no-sandbox",
        "--enable-unsafe-swiftshader",
        "--use-angle=swiftshader",
        "--e2e",
        "--e2e-quit-after-ready",
      ],
      {
        env: {
          ...process.env,
          AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: userDataDirectory,
          CI: "e2e",
        },
        stdio: "ignore",
        windowsHide: true,
      }
    );
    const exited = waitForExit(appProcess);
    await expect
      .poll(
        () => {
          const currentPids = listPackagedProcessIds().filter(
            (pid) => !baselinePids.has(pid)
          );
          for (const pid of currentPids) {
            observedPids.add(pid);
          }
          return currentPids.length;
        },
        { timeout: 30_000 }
      )
      .toBeGreaterThan(0);
    expect(await exited).toBe(0);
    appProcess = undefined;

    await expect
      .poll(() => [...observedPids].filter(isProcessAlive), { timeout: 10_000 })
      .toEqual([]);
    const shutdownLog = fs.readFileSync(
      path.join(userDataDirectory, "logs", "migrate.log"),
      "utf8"
    );
    expect(shutdownLog).toMatch(TRACKED_WORKER_LOG_PATTERN);
    expect(shutdownLog).toContain("quit-cleanup: DONE");
  } finally {
    appProcess?.kill();
    if (
      path.dirname(testRoot) === os.tmpdir() &&
      path.basename(testRoot).startsWith("ai-image-manager-e2e-quit-")
    ) {
      fs.rmSync(testRoot, { force: true, recursive: true });
    }
  }
});
