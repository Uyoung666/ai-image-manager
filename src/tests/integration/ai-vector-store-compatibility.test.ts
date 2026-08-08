import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const testPaths = vi.hoisted(() => ({ dataPath: "" }));

vi.mock("electron", () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => testPaths.dataPath,
    isPackaged: false,
  },
}));

vi.mock("@/utils/data-path", () => ({
  getDataPath: () => testPaths.dataPath,
}));

vi.mock("@/db", () => ({
  getDatabase: () => {
    throw new Error("SQLite is intentionally unavailable in this vector test");
  },
}));

function normalizedVector(dimensions: number): number[] {
  return [1, ...Array.from({ length: dimensions - 1 }, () => 0)];
}

describe.sequential("real vector store fingerprint compatibility", () => {
  beforeAll(async () => {
    const reportsRoot = path.join(process.cwd(), "reports");
    await fsPromises.mkdir(reportsRoot, { recursive: true });
    testPaths.dataPath = await fsPromises.mkdtemp(
      path.join(reportsRoot, "ai-vector-integration-")
    );
  });

  afterAll(async () => {
    const expectedPrefix = path.join(
      process.cwd(),
      "reports",
      "ai-vector-integration-"
    );
    if (path.resolve(testPaths.dataPath).startsWith(expectedPrefix)) {
      await fsPromises.rm(testPaths.dataPath, {
        force: true,
        recursive: true,
      });
    }
  });

  it("writes and reads vectors, blocks A to B, restores B to A, and adopts legacy without rebuilding", async () => {
    const [adapterModule, fingerprintModule, state, vectorDb] =
      await Promise.all([
        import("@/services/ai/model-adapter"),
        import("@/services/ai/model-fingerprint"),
        import("@/services/ai/state"),
        import("@/services/ai/vector-db"),
      ]);
    const adapterA = adapterModule.getActiveEmbeddingAdapter();
    const dimensions = adapterA.embeddingSpace.dimensions;

    await vectorDb.initVectorDB();
    expect(state.photoTable).not.toBeNull();
    await state.photoTable.add([
      {
        photo_id: 1,
        vector: normalizedVector(dimensions),
        created_at: Date.now(),
      },
    ]);
    const firstRead = await vectorDb.getPhotoVectors([1]);
    expect(firstRead.get(1)).toEqual(normalizedVector(dimensions));

    await vectorDb.persistActiveVectorFingerprint("fresh-build");
    expect(
      fingerprintModule.readStoredVectorFingerprint(testPaths.dataPath)
    ).toMatchObject({
      adapterId: adapterA.id,
      dimensions,
      source: "fresh-build",
    });
    await vectorDb.closeVectorDB();

    const adapterB = structuredClone(adapterA);
    adapterB.id = "siglip-v1-integration-adapter-b";
    adapterB.revision = "integration-b";
    adapterModule.registerEmbeddingAdapter(adapterB);
    adapterModule.setActiveEmbeddingAdapter(adapterB.id);

    await expect(vectorDb.initVectorDB()).rejects.toThrow(
      "fingerprint-mismatch"
    );
    expect(state.getActiveEmbeddingRuntime()?.vectorCompatibility).toBe(
      "fingerprint-mismatch"
    );
    await vectorDb.closeVectorDB();

    adapterModule.setActiveEmbeddingAdapter(adapterA.id);
    await vectorDb.initVectorDB();
    expect(await state.photoTable.countRows()).toBe(1);
    expect((await vectorDb.getPhotoVectors([1])).get(1)).toEqual(
      normalizedVector(dimensions)
    );
    await vectorDb.closeVectorDB();

    const markerPath = fingerprintModule.getVectorFingerprintPath(
      testPaths.dataPath
    );
    const preservedMarkerPath = `${markerPath}.pre-legacy-test`;
    await fsPromises.rename(markerPath, preservedMarkerPath);
    expect(fs.existsSync(markerPath)).toBe(false);

    await vectorDb.initVectorDB();
    expect(await state.photoTable.countRows()).toBe(1);
    expect(state.getActiveEmbeddingRuntime()?.vectorCompatibility).toBe(
      "legacy-compatible"
    );
    expect(
      fingerprintModule.readStoredVectorFingerprint(testPaths.dataPath)
    ).toMatchObject({
      adapterId: adapterA.id,
      dimensions,
      source: "legacy-adoption",
    });
    expect((await vectorDb.getPhotoVectors([1])).get(1)).toEqual(
      normalizedVector(dimensions)
    );
    await vectorDb.closeVectorDB();
  });
});
