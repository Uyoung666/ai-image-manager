import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredDiagnosticIncident } from "@/services/diagnostics/incidents";
import type { DiagnosticBundleInput } from "@/types/diagnostics";

vi.mock("@/db", () => ({
  getDatabase: () => ({
    select: () => ({
      from: () => ({
        get: () => ({
          aiProcessed: 35,
          faceProcessed: 18,
          indexed: 40,
          photoRecords: 42,
        }),
      }),
    }),
  }),
}));

vi.mock("@/db/schema", () => ({ photos: {} }));
vi.mock("@/services/settings-manager", () => ({
  getSetting: () => "true",
}));

let testDirectory: string | undefined;

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  if (testDirectory?.startsWith(os.tmpdir())) {
    fs.rmSync(testDirectory, { force: true, recursive: true });
  }
  testDirectory = undefined;
});

describe("diagnostic bundle metadata", () => {
  const incident: StoredDiagnosticIncident = {
    id: "AIM-20260809-123456-ABCD",
    fingerprint: "123456789abc",
    occurredAt: "2026-08-09T12:34:56.000Z",
    source: "renderer-error",
    message: String.raw`Failed to open C:\Users\Alice\Pictures\private.jpg`,
    stack: String.raw`at run (D:\repo\src\services\indexer.ts:42:8)`,
  };
  const input: DiagnosticBundleInput = {
    lastAction: "Clicked import",
    actualBehavior: "The page became blank",
    reproducibility: "sometimes",
  };

  it("redacts only the unsafe field and keeps failure logs and AI state", async () => {
    testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aim-privacy-test-"));
    vi.spyOn(app, "getPath").mockReturnValue(testDirectory);
    vi.spyOn(os, "hostname").mockReturnValue("PRIVATE-MACHINE-34");
    const directory = path.join(testDirectory, "logs");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "app.log"),
      [
        JSON.stringify({
          message: "Worker initialization failed",
          level: "error",
        }),
        JSON.stringify({ message: "Running on PRIVATE-MACHINE-34" }),
        JSON.stringify({ message: "CPU fallback failed", level: "error" }),
      ].join("\n")
    );
    const state = await import("@/services/ai/state");
    state.setCurrentProgress({
      phase: "error",
      processed: 0,
      total: 6019,
      currentFile: String.raw`C:\Users\Alice\Pictures\private.jpg`,
      error: String.raw`Failed to load model at C:\Users\Alice\Models\model.onnx`,
    });
    const { assembleDiagnosticEntries } = await import(
      "@/services/diagnostics/bundle"
    );
    const result = await assembleDiagnosticEntries(incident, input);
    expect(
      result.logs
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    ).toHaveLength(3);
    expect(result.logs).toContain("Worker initialization failed");
    expect(result.logs).toContain("CPU fallback failed");
    expect(result.logs).not.toContain("PRIVATE-MACHINE-34");
    expect(result.logs).toContain("<REDACTED>");
    expect(result.manifest.probes).toMatchObject({
      ai: {
        phase: "error",
        total: 6019,
        lastError: expect.stringContaining("Failed to load model"),
      },
    });
    expect(JSON.stringify(result.manifest)).not.toContain("Alice");
    expect(JSON.stringify(result.manifest)).not.toContain("currentFile");
  });

  it("exports stored failure stacks after runtime state is lost on restart", async () => {
    testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aim-restart-test-"));
    vi.spyOn(app, "getPath").mockReturnValue(testDirectory);
    const { recordAiFailure } = await import(
      "@/services/ai-failure-diagnostics"
    );
    const error = new Error("DirectML session creation failed");
    error.stack =
      "Error: DirectML session creation failed\n at init (C:\\Users\\Alice\\app.asar\\.vite\\build\\main.js:42:8)";
    recordAiFailure(error, {
      stage: "embedding",
      phase: "loading",
      processed: 0,
      total: 6019,
      gpuRequested: true,
      cpuFallbackAttempted: true,
    });
    vi.resetModules();
    const { assembleDiagnosticEntries } = await import(
      "@/services/diagnostics/bundle"
    );
    const result = await assembleDiagnosticEntries(incident, input);
    expect(result.manifest.recentIncidents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "ai-error",
          summary: "DirectML session creation failed",
          stack: expect.stringContaining(".vite/build/main.js:42:8"),
          context: expect.objectContaining({
            total: 6019,
            gpuRequested: true,
            cpuFallbackAttempted: true,
          }),
        }),
      ])
    );
    expect(result.manifest.probes).toMatchObject({ ai: { phase: "idle" } });
    expect(JSON.stringify(result.manifest)).not.toContain("Alice");
  });

  it("retains worker and rotated error logs even when the main log fills the budget", async () => {
    testDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "aim-log-budget-test-")
    );
    vi.spyOn(app, "getPath").mockReturnValue(testDirectory);
    const directory = path.join(testDirectory, "logs");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "app.log"),
      `${JSON.stringify({ message: "x".repeat(4000) })}\n`.repeat(600)
    );
    fs.writeFileSync(
      path.join(directory, "ai-worker.log"),
      "ORT worker initialization failed\n"
    );
    fs.writeFileSync(
      path.join(directory, "app.1.log"),
      JSON.stringify({ level: "error", message: "Previous session failure" })
    );
    const { assembleDiagnosticEntries } = await import(
      "@/services/diagnostics/bundle"
    );
    const result = await assembleDiagnosticEntries(incident, {
      ...input,
      actualBehavior: os.hostname(),
    });
    expect(result.logs).toContain("ORT worker initialization failed");
    expect(result.logs).toContain("Previous session failure");
    expect(Buffer.byteLength(result.logs)).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(
      result.warnings.some((warning) => warning.includes("truncated"))
    ).toBe(true);
    expect(result.report).toContain("<REDACTED>");
    expect(result.manifest.incident).toMatchObject({
      stack: expect.stringContaining("src/services/indexer.ts:42:8"),
    });
  });

  it("builds a compact issue without stack traces or private paths", async () => {
    const { buildGitHubIssue } = await import("@/services/diagnostics/bundle");
    const manifest = {
      app: { version: "2.0.0" },
      system: { platform: "win32", release: "11", arch: "x64" },
    };
    const result = buildGitHubIssue({ incident, input, manifest });

    expect(result.issueUrl).toContain(
      "github.com/Uyoung666/ai-image-manager/issues/new"
    );
    expect(result.issueBody).toContain(incident.id);
    expect(result.issueBody).toContain(incident.fingerprint);
    expect(result.issueBody).not.toContain("Alice");
    expect(result.issueBody).not.toContain("indexer.ts");
  });

  it("caps the prefilled URL while preserving a full clipboard body", async () => {
    const { buildGitHubIssue } = await import("@/services/diagnostics/bundle");
    const longText = "错误描述".repeat(1000);
    const result = buildGitHubIssue({
      incident,
      input: {
        ...input,
        actualBehavior: longText,
        lastAction: longText,
      },
      manifest: {
        app: { version: "2.0.0" },
        system: { arch: "x64", platform: "win32", release: "11" },
      },
    });

    expect(result.issueUrl.length).toBeLessThanOrEqual(7500);
    expect(result.issueBody).toContain(longText);
    expect(new URL(result.issueUrl).searchParams.get("title")).toContain(
      incident.fingerprint
    );
  });

  it("sanitizes automatically collected incident metadata", async () => {
    const { assembleDiagnosticEntries } = await import(
      "@/services/diagnostics/bundle"
    );
    const result = await assembleDiagnosticEntries(incident, {
      ...input,
      actualBehavior: String.raw`Failed on C:\Users\Alice\Pictures\private.jpg`,
    });
    const manifestText = JSON.stringify(result.manifest);

    expect(manifestText).not.toContain("Alice");
    expect(manifestText).not.toContain("private.jpg");
    expect(result.manifest.schemaVersion).toBe(1);
    expect(result.report).toContain(incident.id);
    expect(result.report).not.toContain("Alice");
    expect(result.manifest.probes).toMatchObject({
      database: {
        indexedPhotoRecords: 40,
        photoRecords: 42,
        status: "ok",
      },
    });
  });

  it("creates a readable zip with the fixed safe entries", async () => {
    testDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "aim-diagnostics-test-")
    );
    vi.spyOn(app, "getPath").mockReturnValue(testDirectory);
    const { createDiagnosticBundle } = await import(
      "@/services/diagnostics/bundle"
    );

    const result = await createDiagnosticBundle(input);
    const archive = fs.readFileSync(result.bundlePath);

    expect(archive.subarray(0, 2).toString("ascii")).toBe("PK");
    expect(archive.includes(Buffer.from("report.md"))).toBe(true);
    expect(archive.includes(Buffer.from("manifest.json"))).toBe(true);
    expect(archive.includes(Buffer.from("logs/app.log"))).toBe(true);
    expect(result.nativeDumpIncluded).toBe(false);
  });

  it("normalizes current and legacy logs into valid redacted JSONL", async () => {
    testDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "aim-diagnostics-jsonl-test-")
    );
    vi.spyOn(app, "getPath").mockReturnValue(testDirectory);
    const logDirectory = path.join(testDirectory, "logs");
    fs.mkdirSync(logDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(logDirectory, "app.log"),
      [
        JSON.stringify({
          hostname: "LIUYAN",
          level: "info",
          message: "Update proxy configured",
          proxy: "http://alice:secret@proxy.example/private",
        }),
        String.raw`2026-08-09 failed at C:\Users\Alice\Pictures\private.jpg`,
      ].join("\n"),
      "utf8"
    );
    const { assembleDiagnosticEntries } = await import(
      "@/services/diagnostics/bundle"
    );

    const result = await assembleDiagnosticEntries(incident, input);
    const records = result.logs
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      hostname: "<REDACTED>",
      proxy: "<REDACTED>",
    });
    expect(records[1]).toMatchObject({
      module: "legacy-app.log",
      process: "legacy",
    });
    expect(result.logs).not.toContain("LIUYAN");
    expect(result.logs).not.toContain("Alice");
    expect(Buffer.byteLength(result.logs, "utf8")).toBeLessThanOrEqual(
      2 * 1024 * 1024
    );
  });

  it("keeps generating when a diagnostic probe times out", async () => {
    vi.spyOn(app, "getGPUInfo").mockReturnValue(
      new Promise(() => {
        // Intentionally unresolved to verify the per-probe timeout.
      })
    );
    const { assembleDiagnosticEntries } = await import(
      "@/services/diagnostics/bundle"
    );

    const result = await assembleDiagnosticEntries(incident, input);

    expect(result.manifest.schemaVersion).toBe(1);
    expect(result.warnings.some((warning) => warning.includes("GPU"))).toBe(
      true
    );
  });
});
