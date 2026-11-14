import { describe, expect, it } from "vitest";
import { inspectBackgroundLog } from "../../../scripts/gallery-background-idle.mjs";

const launchedAt = Date.parse("2026-11-12T12:00:00Z");
const row = (msg, extra = {}, time = "2026-11-12T12:00:01Z") =>
  JSON.stringify({ time, msg, ...extra });

describe("background benchmark evidence", () => {
  it("rejects absent, malformed and previous-session evidence", () => {
    const log = [
      "bad",
      row("All services started", {}, "2026-11-11T12:00:00Z"),
    ].join("\n");
    expect(inspectBackgroundLog(log, launchedAt, 1200)).toMatchObject({
      modelInitializationComplete: false,
      scansComplete: false,
    });
  });

  it("requires model initialization and a complete error-free scan independently", () => {
    const scan = row("Import performance summary", {
      scanned: 1200,
      failed: 0,
    });
    expect(inspectBackgroundLog(scan, launchedAt, 1200)).toMatchObject({
      modelInitializationComplete: false,
      scansComplete: true,
    });
    expect(
      inspectBackgroundLog(row("All services started"), launchedAt, 1200)
        .scansComplete
    ).toBe(false);
    expect(
      inspectBackgroundLog(
        [scan, row("All services started")].join("\n"),
        launchedAt,
        1200
      )
    ).toMatchObject({
      modelInitializationComplete: true,
      scansComplete: true,
    });
  });

  it("rejects a later failed or incomplete scan", () => {
    for (const extra of [
      { scanned: 1200, failed: 1 },
      { scanned: 100, failed: 0 },
    ]) {
      const log = [
        row("Import performance summary", { scanned: 1200, failed: 0 }),
        row("Import performance summary", extra),
      ].join("\n");
      expect(inspectBackgroundLog(log, launchedAt, 1200).scansComplete).toBe(
        false
      );
    }
  });
});
