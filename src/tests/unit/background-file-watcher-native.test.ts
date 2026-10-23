/** @vitest-environment node */
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createBackgroundWatcher } from "@/services/background-file-watcher";
import { TestRuntime } from "../helpers/test-runtime";

const RUNTIME_MARKER = /\.aim-test-runtime/;

it("registers real native watches off the main thread and releases them before cleanup", async () => {
  const runtime = new TestRuntime("file-watcher-native");
  const target = path.join(runtime.root, "photo.webp");
  const watcher = createBackgroundWatcher(runtime.root, {
    ignored: [RUNTIME_MARKER],
    ignoreInitial: true,
    ignorePermissionErrors: true,
    depth: 10,
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      watcher.on("ready", resolve).on("error", reject);
    });
    const added = new Promise<string>((resolve) => watcher.on("add", resolve));
    await fs.promises.writeFile(target, "isolated watcher fixture");
    expect(path.resolve(await added)).toBe(target);
    const removed = new Promise<string>((resolve) =>
      watcher.on("unlink", resolve)
    );
    await fs.promises.unlink(target);
    expect(path.resolve(await removed)).toBe(target);
  } finally {
    await watcher.close();
    expect(runtime.cleanup().status).toBe("deleted");
  }
}, 15_000);
