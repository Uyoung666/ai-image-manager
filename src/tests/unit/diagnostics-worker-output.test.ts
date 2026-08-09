import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { app } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureWorkerOutput } from "@/services/diagnostics/worker-output";

let testDirectory: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  if (testDirectory && path.dirname(testDirectory) === os.tmpdir()) {
    fs.rmSync(testDirectory, { force: true, recursive: true });
  }
  testDirectory = undefined;
});

describe("worker diagnostics", () => {
  it("captures stderr and creates an incident for a non-zero exit", () => {
    testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aim-worker-test-"));
    vi.spyOn(app, "getPath").mockReturnValue(testDirectory);
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      stderr: new PassThrough(),
      stdout: new PassThrough(),
    });

    captureWorkerOutput(child, "test-worker");
    child.stderr?.emit(
      "data",
      Buffer.from(String.raw`Failed C:\Users\Alice\private.jpg`)
    );
    child.emit("exit", 2, null);

    const log = fs.readFileSync(
      path.join(testDirectory, "logs", "app.log"),
      "utf8"
    );
    const incidents = fs.readFileSync(
      path.join(testDirectory, "diagnostics", "incidents.jsonl"),
      "utf8"
    );
    expect(log).toContain("test-worker");
    expect(log).not.toContain("Alice");
    expect(incidents).toContain('"source":"worker-crash"');
  });
});
