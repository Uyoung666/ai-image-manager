import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordAiFailure } from "@/services/ai-failure-diagnostics";
import { getRecentIncidentDetails } from "@/services/diagnostics/incidents";

vi.mock("@/services/ai/model-config", () => ({
  getActiveEmbeddingModel: () => ({
    adapterId: "test-siglip",
    modelId: "test/model",
    revision: "test-revision",
  }),
}));

let directory: string | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  if (directory && path.dirname(directory) === os.tmpdir()) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("AI failure diagnostics", () => {
  const context = {
    stage: "model-resolution",
    phase: "loading",
    processed: 0,
    total: 6019,
    gpuRequested: null,
    cpuFallbackAttempted: false,
  };

  it("persists the actual handled error and refreshes repeated failure context", () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "aim-ai-failure-"));
    vi.spyOn(app, "getPath").mockReturnValue(directory);
    const cause = Object.assign(new Error("Unable to allocate provider"), {
      code: "ORT_INIT_FAILED",
    });
    const error = new Error("Model initialization failed", { cause });
    recordAiFailure(error, context);
    const first = getRecentIncidentDetails()[0];
    recordAiFailure(error, { ...context, total: 6020, gpuRequested: true });
    const incidents = getRecentIncidentDetails();
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      id: first.id,
      source: "ai-error",
      message: error.message,
      context: { total: 6020, gpuRequested: true, modelId: "test/model" },
    });
    expect(incidents[0].stack).toContain("Model initialization failed");
    expect(incidents[0].stack).toContain("ORT_INIT_FAILED");
    expect(incidents[0].stack).toContain("Unable to allocate provider");
  });

  it("does not throw when diagnostic storage is unavailable", () => {
    vi.spyOn(app, "getPath").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    expect(() =>
      recordAiFailure(new Error("original failure"), context)
    ).not.toThrow();
  });
});
