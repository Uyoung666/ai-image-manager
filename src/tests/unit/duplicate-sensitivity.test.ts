import { describe, expect, it } from "vitest";
import { getDuplicateSensitivityConfig } from "@/services/duplicate-sensitivity";

describe("default duplicate detection strategy", () => {
  it("uses the same strategy regardless of legacy preferences", () => {
    for (const value of [null, "strict", "standard", "loose", "unknown"]) {
      expect(getDuplicateSensitivityConfig(value)).toEqual({
        preset: "standard",
        phashThreshold: 8,
        embeddingThreshold: 0.95,
        version: "duplicate-thresholds-v2",
      });
    }
  });
});
