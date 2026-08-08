import { describe, expect, it } from "vitest";
import {
  getSensitivityMultiplier,
  SEARCH_SENSITIVITY_OPTIONS,
} from "@/services/ai/search-sensitivity";

describe("semantic search sensitivity", () => {
  it("uses stable recall-to-precision multipliers", () => {
    expect(SEARCH_SENSITIVITY_OPTIONS).toEqual([
      "relaxed",
      "standard",
      "precise",
    ]);
    expect(getSensitivityMultiplier("relaxed")).toBe(0.6);
    expect(getSensitivityMultiplier("standard")).toBe(1);
    expect(getSensitivityMultiplier("precise")).toBe(1.4);
  });
});
