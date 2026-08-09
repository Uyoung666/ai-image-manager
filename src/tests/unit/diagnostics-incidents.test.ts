import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendIncident,
  createErrorFingerprint,
  createIncidentId,
  dismissStoredIncident,
  listStoredIncidents,
  recordDiagnosticIncident,
} from "@/services/diagnostics/incidents";

const INCIDENT_ID_PATTERN = /^AIM-20260809-123456-[0-9A-F]{4}$/;
let testDirectory: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  if (testDirectory && path.dirname(testDirectory) === os.tmpdir()) {
    fs.rmSync(testDirectory, { force: true, recursive: true });
  }
  testDirectory = undefined;
});

describe("diagnostic incident identity", () => {
  it("creates a readable unique incident id", () => {
    const id = createIncidentId(new Date("2026-08-09T12:34:56.000Z"));
    expect(id).toMatch(INCIDENT_ID_PATTERN);
  });

  it("keeps fingerprints stable when only paths and line numbers differ", () => {
    const first = createErrorFingerprint(
      "Failed to load",
      String.raw`Error: Failed to load\n at run (C:\Users\A\src\indexer.ts:12:4)`
    );
    const second = createErrorFingerprint(
      "Failed to load",
      String.raw`Error: Failed to load\n at run (D:\Work\src\indexer.ts:98:2)`
    );
    expect(first).toHaveLength(12);
    expect(first).toBe(second);

    const fileUrlFirst = createErrorFingerprint(
      "Failed to load",
      "Error: Failed to load at file:///C:/Users/A/src/indexer.ts:12:4"
    );
    const fileUrlSecond = createErrorFingerprint(
      "Failed to load",
      "Error: Failed to load at file:///D:/Work/src/indexer.ts:98:2"
    );
    expect(fileUrlFirst).toBe(fileUrlSecond);
  });

  it("coalesces repeated pending incidents with the same source and fingerprint", () => {
    testDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "aim-incidents-dedupe-test-")
    );
    vi.spyOn(app, "getPath").mockReturnValue(testDirectory);

    const first = recordDiagnosticIncident({
      message: "Renderer failed to start",
      source: "renderer-error",
      stack: "Error: Renderer failed to start\n at boot (C:\\app\\main.ts:1:1)",
    });
    const second = recordDiagnosticIncident({
      message: "Renderer failed to start",
      source: "renderer-error",
      stack:
        "Error: Renderer failed to start\n at boot (D:\\app\\main.ts:99:4)",
    });

    expect(second.id).toBe(first.id);
    expect(listStoredIncidents()).toHaveLength(1);
  });

  it("allows a new occurrence after the previous incident was dismissed", () => {
    testDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "aim-incidents-dismiss-test-")
    );
    vi.spyOn(app, "getPath").mockReturnValue(testDirectory);

    const first = recordDiagnosticIncident({
      message: "Renderer failed to start",
      source: "renderer-error",
    });
    expect(dismissStoredIncident(first.id)).toBe(true);

    const second = recordDiagnosticIncident({
      message: "Renderer failed to start",
      source: "renderer-error",
    });
    expect(second.id).not.toBe(first.id);
    expect(listStoredIncidents()).toHaveLength(1);
    expect(listStoredIncidents()[0]?.id).toBe(second.id);
  });

  it("compacts legacy duplicate records when they are listed", () => {
    testDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "aim-incidents-legacy-dedupe-test-")
    );
    vi.spyOn(app, "getPath").mockReturnValue(testDirectory);

    const base = {
      fingerprint: "duplicate000",
      message: "Repeated worker failure",
      source: "worker-crash" as const,
    };
    appendIncident({
      ...base,
      id: "AIM-OLD",
      occurredAt: "2026-08-09T12:00:00.000Z",
    });
    appendIncident({
      ...base,
      id: "AIM-NEW",
      occurredAt: "2026-08-09T12:01:00.000Z",
    });

    const incidents = listStoredIncidents();
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.id).toBe("AIM-NEW");
    expect(
      fs.readFileSync(
        path.join(testDirectory, "diagnostics", "incidents.jsonl"),
        "utf8"
      )
    ).toContain('"id":"AIM-NEW"');
    expect(
      fs.readFileSync(
        path.join(testDirectory, "diagnostics", "incidents.jsonl"),
        "utf8"
      )
    ).not.toContain('"id":"AIM-OLD"');
  });

  it("redacts incidents before persistence and retains only 20 recent items", () => {
    testDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "aim-incidents-test-")
    );
    vi.spyOn(app, "getPath").mockReturnValue(testDirectory);
    recordDiagnosticIncident({
      message: String.raw`Failed at C:\Users\Alice\Pictures\private.jpg`,
      route: "/albums/private-id?query=family",
      source: "renderer-error",
    });
    const storedText = fs.readFileSync(
      path.join(testDirectory, "diagnostics", "incidents.jsonl"),
      "utf8"
    );
    expect(storedText).not.toContain("Alice");
    expect(storedText).not.toContain("private.jpg");
    expect(storedText).not.toContain("family");

    for (let index = 0; index < 22; index += 1) {
      appendIncident({
        fingerprint: `${index}`.padStart(12, "0"),
        id: `AIM-RECENT-${index}`,
        message: `Recent incident ${index}`,
        occurredAt: new Date(Date.now() - index * 1000).toISOString(),
        source: "main-crash",
      });
    }
    appendIncident({
      fingerprint: "expired00000",
      id: "AIM-EXPIRED",
      message: "Expired incident",
      occurredAt: "2020-01-01T00:00:00.000Z",
      source: "main-crash",
    });

    const incidents = listStoredIncidents();
    expect(incidents).toHaveLength(20);
    expect(incidents.some((incident) => incident.id === "AIM-EXPIRED")).toBe(
      false
    );
  });
});
