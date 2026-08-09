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

let testDirectory: string | undefined;

afterEach(() => {
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

  it("builds a compact issue without stack traces or private paths", async () => {
    const { buildGitHubIssue } = await import("@/services/diagnostics/bundle");
    const manifest = {
      app: { version: "1.4.0" },
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
        app: { version: "1.4.0" },
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
    const records = result.logs.trim().split("\n").map(JSON.parse);

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
