import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendDiagnosticLog,
  getDiagnosticLogSize,
} from "@/services/diagnostics/logging";

const MAX_LOG_BUDGET = 25 * 1024 * 1024;
const LOG_FILE_PATTERN = /^app(?:\.\d+)?\.log$/;
const SESSION_ID_PATTERN = /^SESSION-/;
let testDirectory: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  if (testDirectory && path.dirname(testDirectory) === os.tmpdir()) {
    fs.rmSync(testDirectory, { force: true, recursive: true });
  }
  testDirectory = undefined;
});

describe("diagnostic logging", () => {
  it("redacts before persistence and rotates within five files", () => {
    testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aim-logging-test-"));
    vi.spyOn(app, "getPath").mockReturnValue(testDirectory);

    appendDiagnosticLog({
      level: "error",
      message: String.raw`token=secret path=C:\Users\Alice\photo.jpg`,
      module: "test",
      process: "main",
    });
    const logFile = path.join(testDirectory, "logs", "app.log");
    const firstRecord = JSON.parse(
      fs.readFileSync(logFile, "utf8").trim()
    ) as Record<string, unknown>;
    expect(firstRecord.sessionId).toMatch(SESSION_ID_PATTERN);
    expect(firstRecord.message).not.toContain("secret");
    expect(firstRecord.message).not.toContain("Alice");

    const largeMessage = "x".repeat(32_768);
    for (let index = 0; index < 800; index += 1) {
      appendDiagnosticLog({
        level: "info",
        message: `${index}:${largeMessage}`,
        module: "rotation-test",
        process: "main",
      });
    }

    const files = fs
      .readdirSync(path.dirname(logFile))
      .filter((name) => LOG_FILE_PATTERN.test(name));
    expect(files.length).toBeLessThanOrEqual(5);
    expect(files).toContain("app.4.log");
    expect(getDiagnosticLogSize()).toBeLessThanOrEqual(MAX_LOG_BUDGET);
  });
});
