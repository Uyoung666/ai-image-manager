/** @vitest-environment node */
import fs from "node:fs";
import type { Connection, Table } from "@lancedb/lancedb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  setColorTable,
  setIsVectorDBReady,
  setPhotoTable,
  setVectordb,
} from "@/services/ai/state";
import {
  closeVectorDB,
  deleteColorVectors,
  deletePhotoVectors,
  getVectorDbGeneration,
  rebuildVectorDB,
  withVectorDbOperation,
} from "@/services/ai/vector-db";

beforeEach(() => {
  // Closing a mocked connection must not create user-profile diagnostic files.
  vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
  vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
});
afterEach(() => {
  setPhotoTable(null);
  setColorTable(null);
  setVectordb(null);
  setIsVectorDBReady(false);
  vi.restoreAllMocks();
});

it.each([
  "close",
  "rebuild",
] as const)("discards old queued image and color deletion after %s while accepting new-generation work", async (transition) => {
  const oldTable = {
    close: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const newTable = {
    close: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  setPhotoTable(oldTable as unknown as Table);
  setColorTable(oldTable as unknown as Table);
  setIsVectorDBReady(true);
  if (transition === "rebuild") {
    // Even a failed rebuild invalidates outstanding work before recovery.
    setVectordb({
      tableNames: vi
        .fn()
        .mockRejectedValue(new Error("injected rebuild failure")),
    } as unknown as Connection);
  }
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const holding = withVectorDbOperation(() => {
    entered();
    return blocked;
  });
  await ready;
  const generation = getVectorDbGeneration();
  const changing = transition === "close" ? closeVectorDB() : rebuildVectorDB();
  const replacing = withVectorDbOperation(() => {
    setPhotoTable(newTable as unknown as Table);
    setColorTable(newTable as unknown as Table);
    setIsVectorDBReady(true);
  });
  const deletingPhoto = deletePhotoVectors([7]);
  const deletingColor = deleteColorVectors([7]);
  release();
  await Promise.all([
    holding,
    changing,
    replacing,
    deletingPhoto,
    deletingColor,
  ]);
  expect(getVectorDbGeneration()).toBeGreaterThan(generation);
  expect(oldTable.delete).not.toHaveBeenCalled();
  expect(newTable.delete).not.toHaveBeenCalled();
  await Promise.all([deletePhotoVectors([7]), deleteColorVectors([7])]);
  expect(newTable.delete).toHaveBeenCalledTimes(2);
  expect(newTable.delete).toHaveBeenNthCalledWith(1, "photo_id IN (7)");
  expect(newTable.delete).toHaveBeenNthCalledWith(2, "photo_id IN (7)");
});
