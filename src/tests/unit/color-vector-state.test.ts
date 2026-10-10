// @vitest-environment node
import type { Table } from "@lancedb/lancedb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setColorTable } from "@/services/ai/state";
import {
  deleteColorVectors,
  searchByColorVector,
  upsertColorVector,
  upsertColorVectors,
} from "@/services/ai/vector-db";
import { getVectorSearchRevision } from "@/services/search-revision";

afterEach(() => setColorTable(null));

describe("color vector state", () => {
  it("serializes delete/add with searches and invalidates cached sessions", async () => {
    const events: string[] = [];
    let release: () => void = () => undefined;
    const pendingDelete = new Promise<void>((resolve) => {
      release = resolve;
    });
    const builder = {
      bypassVectorIndex: vi.fn().mockReturnThis(),
      distanceType: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      toArray: vi.fn(async () => {
        await Promise.resolve();
        events.push("query");
        return [{ photo_id: 1, _distance: 0 }];
      }),
      where: vi.fn().mockReturnThis(),
    };
    const table = {
      add: vi.fn(async () => {
        await Promise.resolve();
        events.push("add");
      }),
      delete: vi.fn(async () => {
        events.push("delete");
        await pendingDelete;
      }),
      vectorSearch: vi.fn(() => builder),
    };
    setColorTable(table as unknown as Table);
    const revision = getVectorSearchRevision();
    const writing = upsertColorVector(1, 255, 0, 0);
    await vi.waitFor(() => expect(table.delete).toHaveBeenCalledOnce());
    const searching = searchByColorVector(255, 0, 0, 1, [1], true);
    await Promise.resolve();
    expect(table.vectorSearch).not.toHaveBeenCalled();
    release();
    await writing;
    expect(await searching).toEqual([{ photoId: 1, distanceSquared: 0 }]);
    expect(events).toEqual(["delete", "add", "query"]);
    expect(getVectorSearchRevision()).not.toBe(revision);
  });

  it("invalidates after a partially failed replacement and after deletion", async () => {
    setColorTable({
      add: vi.fn().mockRejectedValue(new Error("failed after deletion")),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as Table);
    const before = getVectorSearchRevision();
    await expect(
      upsertColorVectors([{ photoId: 1, r: 255, g: 0, b: 0 }])
    ).rejects.toThrow("failed after deletion");
    const afterFailure = getVectorSearchRevision();
    expect(afterFailure).not.toBe(before);
    await deleteColorVectors([1]);
    expect(getVectorSearchRevision()).not.toBe(afterFailure);
  });
});
