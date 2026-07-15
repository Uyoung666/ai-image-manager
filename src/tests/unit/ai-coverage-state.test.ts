import { describe, expect, it } from "vitest";
import { deriveAiCoverageState } from "@/services/ai/coverage";

describe("AI semantic index coverage", () => {
  it.each([
    [0, 0, false, "ready"],
    [100, 0, false, "unavailable"],
    [100, 25, false, "partial"],
    [100, 100, false, "ready"],
    [100, 100, true, "error"],
  ] as const)("maps total=%i indexed=%i error=%s to %s", (total, indexed, hasError, expected) => {
    expect(deriveAiCoverageState(total, indexed, hasError)).toBe(expected);
  });
});
