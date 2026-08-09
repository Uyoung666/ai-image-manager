import { describe, expect, it, vi } from "vitest";
import {
  BatchPhotoIdsSchema,
  TrashListSchema,
} from "@/ipc/photos/handlers/shared";
import { executeSystemTrashMove } from "@/services/trash-operations";

describe("recently deleted schemas", () => {
  it("deduplicates valid batch ids", () => {
    expect(BatchPhotoIdsSchema.parse({ ids: [3, 3, 7] }).ids).toEqual([3, 7]);
  });

  it("rejects empty, invalid, and oversized batches", () => {
    expect(BatchPhotoIdsSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(BatchPhotoIdsSchema.safeParse({ ids: [0] }).success).toBe(false);
    expect(
      BatchPhotoIdsSchema.safeParse({
        ids: Array.from({ length: 1001 }, (_, index) => index + 1),
      }).success
    ).toBe(false);
  });

  it("applies bounded list defaults", () => {
    expect(TrashListSchema.parse({})).toEqual({
      cursor: null,
      limit: 100,
      order: "desc",
      query: "",
      sort: "deletedAt",
    });
    expect(TrashListSchema.safeParse({ limit: 201 }).success).toBe(false);
  });

  it("accepts stable keyset cursors and trims search text", () => {
    expect(
      TrashListSchema.parse({
        cursor: { id: 9, value: "photo.jpg" },
        query: "  photo  ",
        sort: "name",
      })
    ).toMatchObject({
      cursor: { id: 9, value: "photo.jpg" },
      query: "photo",
      sort: "name",
    });
    expect(TrashListSchema.safeParse({ cursor: 100 }).success).toBe(false);
  });
});

describe("executeSystemTrashMove", () => {
  it("hard-deletes only files moved successfully", async () => {
    const hardDelete = vi.fn();
    const trashFile = vi.fn((filePath: string) => {
      if (filePath === "failed.jpg") {
        return Promise.reject(new Error("access denied"));
      }
      return Promise.resolve();
    });

    const result = await executeSystemTrashMove(
      [
        { id: 1, path: "ok.jpg" },
        { id: 2, path: "failed.jpg" },
      ],
      {
        fileExists: async () => true,
        hardDelete,
        trashFile,
      }
    );

    expect(result.succeededIds).toEqual([1]);
    expect(result.failed).toEqual([
      {
        code: "FILE_OPERATION_FAILED",
        id: 2,
        message: "access denied",
      },
    ]);
    expect(hardDelete).toHaveBeenCalledWith([1]);
  });

  it("cleans up missing files without calling the system trash", async () => {
    const hardDelete = vi.fn();
    const trashFile = vi.fn();

    const result = await executeSystemTrashMove(
      [{ id: 5, path: "missing.jpg" }],
      {
        fileExists: async () => false,
        hardDelete,
        trashFile,
      }
    );

    expect(result).toEqual({ failed: [], succeededIds: [5] });
    expect(trashFile).not.toHaveBeenCalled();
    expect(hardDelete).toHaveBeenCalledWith([5]);
  });

  it("does not touch the database when every file operation fails", async () => {
    const hardDelete = vi.fn();
    const result = await executeSystemTrashMove(
      [{ id: 8, path: "locked.jpg" }],
      {
        fileExists: async () => true,
        hardDelete,
        trashFile: () => Promise.reject(new Error("locked")),
      }
    );

    expect(result.succeededIds).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(hardDelete).not.toHaveBeenCalled();
  });

  it("treats a race-time ENOENT as idempotently missing", async () => {
    const hardDelete = vi.fn();
    const result = await executeSystemTrashMove(
      [{ id: 9, path: "vanished.jpg" }],
      {
        fileExists: async () => true,
        hardDelete,
        trashFile: () =>
          Promise.reject(
            Object.assign(new Error("missing"), { code: "ENOENT" })
          ),
      }
    );

    expect(result).toEqual({ failed: [], succeededIds: [9] });
    expect(hardDelete).toHaveBeenCalledWith([9]);
  });

  it("does not treat permission errors as missing files", async () => {
    const hardDelete = vi.fn();
    const result = await executeSystemTrashMove(
      [{ id: 10, path: "protected.jpg" }],
      {
        fileExists: () =>
          Promise.reject(
            Object.assign(new Error("access denied"), { code: "EACCES" })
          ),
        hardDelete,
        trashFile: vi.fn(),
      }
    );

    expect(result.failed[0]?.code).toBe("FILE_OPERATION_FAILED");
    expect(hardDelete).not.toHaveBeenCalled();
  });
});
