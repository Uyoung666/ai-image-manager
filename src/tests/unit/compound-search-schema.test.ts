import { describe, expect, it } from "vitest";
import {
  CompoundSearchSchema,
  deferSearchBranch,
} from "@/ipc/photos/handlers/shared";

describe("compound search filters", () => {
  it("accepts valid month and hour filters", () => {
    expect(
      CompoundSearchSchema.parse({ dateMonth: 7, dateHour: 0 })
    ).toMatchObject({ dateMonth: 7, dateHour: 0 });
  });

  it("rejects out-of-range month and hour filters", () => {
    expect(() => CompoundSearchSchema.parse({ dateMonth: 13 })).toThrow();
    expect(() => CompoundSearchSchema.parse({ dateHour: 24 })).toThrow();
  });

  it("accepts a creator filter", () => {
    expect(CompoundSearchSchema.parse({ creator: "Jane Doe" })).toMatchObject({
      creator: "Jane Doe",
    });
  });

  it("accepts bounded search pagination", () => {
    expect(
      CompoundSearchSchema.parse({ limit: 200, offset: 400 })
    ).toMatchObject({
      limit: 200,
      offset: 400,
    });
    expect(() => CompoundSearchSchema.parse({ limit: 201 })).toThrow();
    expect(() => CompoundSearchSchema.parse({ offset: -1 })).toThrow();
  });

  it("accepts an opaque UUID cursor and rejects malformed cursors", () => {
    const cursor = "8af4bf7d-8d8e-44e3-834f-d67ed01f4f6d";
    expect(CompoundSearchSchema.parse({ cursor })).toMatchObject({ cursor });
    expect(() => CompoundSearchSchema.parse({ cursor: "offset:100" })).toThrow();
  });

  it("isolates synchronous branch failures inside allSettled", async () => {
    const semanticResults = [{ photoId: 1, similarity: 0.09 }];
    const settled = await Promise.allSettled([
      Promise.resolve(semanticResults),
      deferSearchBranch(() => {
        throw new Error("missing optional tag column");
      }),
    ]);

    expect(settled[0]).toEqual({
      status: "fulfilled",
      value: semanticResults,
    });
    expect(settled[1]).toMatchObject({ status: "rejected" });
  });
});
