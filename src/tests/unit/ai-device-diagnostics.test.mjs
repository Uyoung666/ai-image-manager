import assert from "node:assert/strict";
import { it } from "vitest";
import {
  aggregateDiagnostics,
  createExecutionPlan,
  parseArguments,
} from "../../../scripts/run-ai-device-diagnostics.mjs";

it("device diagnostics rotates all three configurations", () => {
  assert.deepEqual(createExecutionPlan(2), [
    { profileId: "low-1x1", round: 1 },
    { profileId: "automatic", round: 1 },
    { profileId: "high-2x4", round: 1 },
    { profileId: "automatic", round: 2 },
    { profileId: "high-2x4", round: 2 },
    { profileId: "low-1x1", round: 2 },
  ]);
});

it("device diagnostics validates long-run bounds", () => {
  assert.equal(parseArguments([]).count, 1000);
  assert.throws(() => parseArguments(["--count", "499"]));
  assert.throws(() => parseArguments(["--count", "1001"]));
  assert.throws(() => parseArguments(["--trials", "0"]));
});

it("device diagnostics separates parent and worker memory aggregates", () => {
  const trial = {
    profileId: "automatic",
    status: "complete",
    errorCount: 0,
    execution: { workerCount: 2, threadsPerWorker: 4 },
    throughputPerSecond: 10,
    memory: {
      combinedRssDeltaBytes: 30,
      parentRssDeltaBytes: 10,
      workerRssDeltaBytes: 20,
      leakReviewRecommended: true,
    },
  };
  const aggregate = aggregateDiagnostics([trial, { ...trial }]).automatic;
  assert.deepEqual(aggregate.actualConfigurations, ["2x4"]);
  assert.equal(aggregate.steadyStateMemory.parentRssDeltaBytes.median, 10);
  assert.equal(aggregate.steadyStateMemory.workerRssDeltaBytes.median, 20);
  assert.equal(aggregate.steadyStateMemory.leakReviewTrialCount, 2);
});
