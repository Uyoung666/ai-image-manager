import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { afterEach, expect, it, vi } from "vitest";

const databaseFailure = vi.hoisted(
  () => new Error("Database initialization failed")
);
vi.mock("@/db", () => ({
  getDatabase: () => {
    throw databaseFailure;
  },
}));

let directory: string | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  if (directory && path.dirname(directory) === os.tmpdir()) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

it("records an actual indexing failure and still releases the run for retry", async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "aim-index-failure-"));
  vi.spyOn(app, "getPath").mockReturnValue(directory);
  const { embedAllPhotos } = await import("@/services/ai/embedder");
  const { getRecentIncidentDetails } = await import(
    "@/services/diagnostics/incidents"
  );
  const state = await import("@/services/ai/state");
  await expect(embedAllPhotos()).rejects.toBe(databaseFailure);
  expect(state.aiControlState).toBe("idle");
  expect(state.currentProgress.error).toBe(databaseFailure.message);
  expect(getRecentIncidentDetails()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        source: "ai-error",
        message: databaseFailure.message,
        context: expect.objectContaining({ stage: "database" }),
      }),
    ])
  );
});
