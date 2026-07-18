import { describe, expect, it } from "vitest";
import { CompoundSearchSchema } from "@/ipc/photos/handlers/shared";

describe("compound search periodic date filters", () => {
  it("accepts valid month and hour filters", () => {
    expect(
      CompoundSearchSchema.parse({ dateMonth: 7, dateHour: 0 })
    ).toMatchObject({ dateMonth: 7, dateHour: 0 });
  });

  it("rejects out-of-range month and hour filters", () => {
    expect(() => CompoundSearchSchema.parse({ dateMonth: 13 })).toThrow();
    expect(() => CompoundSearchSchema.parse({ dateHour: 24 })).toThrow();
  });
});
