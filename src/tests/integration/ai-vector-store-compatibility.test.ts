import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@/services/ai/model-loader", () => ({
  loadModel: async () => undefined,
}));

function normalizedVector(dimensions: number): number[] {
  return [1, ...Array.from({ length: dimensions - 1 }, () => 0)];
}

describe.sequential("real vector store fingerprint compatibility", () => {
  beforeEach(async () => {
    const reportsRoot = path.join(process.cwd(), "reports");
    await fsPromises.mkdir(reportsRoot, { recursive: true });
    testPaths.dataPath = await fsPromises.mkdtemp(
      path.join(reportsRoot, "ai-vector-integration-")
    );
  });

  afterEach(async () => {
    const [adapterModule, vectorDb] = await Promise.all([
      import("@/services/ai/model-adapter"),
      import("@/services/ai/vector-db"),
    ]);
    await vectorDb.closeVectorDB();
    vi.restoreAllMocks();
    adapterModule.registerEmbeddingAdapter(adapterModule.SIGLIP_V1_ADAPTER);
    adapterModule.setActiveEmbeddingAdapter(adapterModule.SIGLIP_V1_ADAPTER.id);
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

  it("writes and reads vectors, blocks A to B, restores B to A, and rejects unmarked old vectors", async () => {
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
    const initialTable = state.photoTable;
    if (!initialTable) {
      throw new Error("Expected vector table to be initialized");
    }
    await initialTable.add([
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
    const restoredTable = state.photoTable;
    if (!restoredTable) {
      throw new Error("Expected vector table to be restored");
    }
    expect(await restoredTable.countRows()).toBe(1);
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

    await expect(vectorDb.initVectorDB()).rejects.toThrow(
      "missing-fingerprint"
    );
    expect(state.getActiveEmbeddingRuntime()?.vectorCompatibility).toBe(
      "missing-fingerprint"
    );
    expect(
      fingerprintModule.readStoredVectorFingerprint(testPaths.dataPath)
    ).toBeNull();
  });

  it("resumes a same-fingerprint building store and promotes only the completed marker", async () => {
    const [adapterModule, fingerprintModule, state, vectorDb] =
      await Promise.all([
        import("@/services/ai/model-adapter"),
        import("@/services/ai/model-fingerprint"),
        import("@/services/ai/state"),
        import("@/services/ai/vector-db"),
      ]);
    const adapter = adapterModule.getActiveEmbeddingAdapter();
    const dimensions = adapter.embeddingSpace.dimensions;
    await vectorDb.initVectorDB();
    await state.photoTable?.add([
      {
        photo_id: 1,
        vector: normalizedVector(dimensions),
        created_at: Date.now(),
      },
    ]);
    await vectorDb.persistActiveVectorFingerprint("fresh-build", "building");
    expect(
      fingerprintModule.readStoredVectorFingerprint(testPaths.dataPath)
        ?.buildState
    ).toBe("building");
    await vectorDb.closeVectorDB();

    await vectorDb.initVectorDB();
    expect(state.getActiveEmbeddingRuntime()).toMatchObject({
      vectorBuildState: "building",
      vectorCompatibility: "matching",
    });
    expect(await state.photoTable?.countRows()).toBe(1);
    expect((await vectorDb.getPhotoVectors([1])).get(1)).toEqual(
      normalizedVector(dimensions)
    );
    expect(fingerprintModule.isVectorCompatibilitySearchable("matching")).toBe(
      true
    );

    await vectorDb.persistActiveVectorFingerprint("fresh-build", "ready");
    expect(state.getActiveEmbeddingRuntime()).toMatchObject({
      vectorBuildState: "ready",
      vectorCompatibility: "matching",
    });
    expect(
      fingerprintModule.readStoredVectorFingerprint(testPaths.dataPath)
        ?.buildState
    ).toBe("ready");

    await vectorDb.closeVectorDB();
    await vectorDb.initVectorDB();
    expect(state.getActiveEmbeddingRuntime()?.vectorBuildState).toBe("ready");
    expect(await state.photoTable?.countRows()).toBe(1);
  });

  it("keeps readiness initialization and health probes out of an unfinished rebuild", async () => {
    const [state, vectorDb, health, fingerprint] = await Promise.all([
      import("@/services/ai/state"),
      import("@/services/ai/vector-db"),
      import("@/services/ai/health"),
      import("@/services/ai/model-fingerprint"),
    ]);
    await vectorDb.initVectorDB();
    const vectorPath = path.join(testPaths.dataPath, "vectors");
    const remove = fs.promises.rm.bind(fs.promises);
    const removalStarted = Promise.withResolvers<void>();
    const allowRemoval = Promise.withResolvers<void>();
    const removeSpy = vi
      .spyOn(fs.promises, "rm")
      .mockImplementation(async (target, options) => {
        if (String(target) === vectorPath) {
          removalStarted.resolve();
          await allowRemoval.promise;
        }
        await remove(target, options);
      });
    const rebuilding = vectorDb.rebuildVectorDB();
    await removalStarted.promise;
    let initialized = false;
    let probed = false;
    const polling = vectorDb.initVectorDB().then(() => {
      initialized = true;
    });
    const probing = health.checkAiHealth().then((result) => {
      probed = true;
      return result;
    });
    try {
      // Give a racing initializer enough time to connect and recreate tables.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(initialized).toBe(false);
      expect(probed).toBe(false);
      expect(state.vectordb).toBeNull();
      expect(state.photoTable).toBeNull();
      expect(state.colorTable).toBeNull();
    } finally {
      allowRemoval.resolve();
      await Promise.allSettled([rebuilding, polling, probing]);
    }
    expect(await rebuilding).toEqual({ success: true });
    expect(await probing).toMatchObject({ lancedb: "ok", vectorTableRows: 0 });
    expect(await state.photoTable?.countRows()).toBe(0);
    expect(
      fingerprint.readStoredVectorFingerprint(testPaths.dataPath)?.buildState
    ).toBe("building");
    expect(removeSpy).toHaveBeenCalledWith(
      vectorPath,
      expect.objectContaining({ maxRetries: 3 })
    );
  });

  it("waits for an initializer already in flight before closing and rebuilding its connection", async () => {
    const [state, vectorDb] = await Promise.all([
      import("@/services/ai/state"),
      import("@/services/ai/vector-db"),
    ]);
    const readDirectory = fs.promises.readdir.bind(fs.promises);
    const initializationStarted = Promise.withResolvers<void>();
    const allowInitialization = Promise.withResolvers<void>();
    vi.spyOn(fs.promises, "readdir").mockImplementationOnce(async (...args) => {
      initializationStarted.resolve();
      await allowInitialization.promise;
      return readDirectory(...args);
    });
    const initializing = vectorDb.initVectorDB();
    await initializationStarted.promise;
    const generation = vectorDb.getVectorDbGeneration();
    const rebuilding = vectorDb.rebuildVectorDB();
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(vectorDb.getVectorDbGeneration()).toBe(generation);
    } finally {
      allowInitialization.resolve();
      await Promise.allSettled([initializing, rebuilding]);
    }
    await expect(initializing).resolves.toBeUndefined();
    expect(await rebuilding).toEqual({ success: true });
    expect(state.isVectorDBReady).toBe(true);
    expect(await state.photoTable?.countRows()).toBe(0);
  });

  it("waits for photo-vector reads before dropping their table", async () => {
    const [adapterModule, state, vectorDb] = await Promise.all([
      import("@/services/ai/model-adapter"),
      import("@/services/ai/state"),
      import("@/services/ai/vector-db"),
    ]);
    await vectorDb.initVectorDB();
    const table = state.photoTable;
    if (!table) {
      throw new Error("Expected initialized photo table");
    }
    const vector = normalizedVector(
      adapterModule.getActiveEmbeddingAdapter().embeddingSpace.dimensions
    );
    await table.add([{ photo_id: 1, vector, created_at: Date.now() }]);
    const originalQuery = table.query.bind(table);
    const readingStarted = Promise.withResolvers<void>();
    const allowRead = Promise.withResolvers<void>();
    vi.spyOn(table, "query").mockImplementation(() => {
      const query = originalQuery();
      const read = query.toArray.bind(query);
      vi.spyOn(query, "toArray").mockImplementationOnce(async () => {
        readingStarted.resolve();
        await allowRead.promise;
        return read();
      });
      return query;
    });
    const reading = vectorDb.getPhotoVectors([1], true);
    await readingStarted.promise;
    const generation = vectorDb.getVectorDbGeneration();
    const rebuilding = vectorDb.rebuildVectorDB();
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(vectorDb.getVectorDbGeneration()).toBe(generation);
    } finally {
      allowRead.resolve();
      await Promise.allSettled([reading, rebuilding]);
    }
    expect((await reading).get(1)).toEqual(vector);
    expect(await rebuilding).toEqual({ success: true });
  });

  it.each([
    "ENOTEMPTY",
    "EPERM",
    "EBUSY",
  ])("recovers from a Windows %s directory lock on the first rebuild", async (code) => {
    const [state, vectorDb] = await Promise.all([
      import("@/services/ai/state"),
      import("@/services/ai/vector-db"),
    ]);
    await vectorDb.initVectorDB();
    const oldColorTable = state.colorTable;
    const original = path.join(testPaths.dataPath, "original-photo.png");
    await fsPromises.writeFile(original, "preserve this original");
    const vectorPath = path.join(testPaths.dataPath, "vectors");
    const remove = fs.promises.rm.bind(fs.promises);
    vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
      if (String(target) === vectorPath) {
        throw Object.assign(new Error("simulated Windows directory lock"), {
          code,
        });
      }
      await remove(target, options);
    });
    const renameSpy = vi.spyOn(fs.promises, "rename");
    expect(await vectorDb.rebuildVectorDB()).toEqual({ success: true });
    expect(renameSpy).toHaveBeenCalledWith(
      vectorPath,
      expect.stringContaining(`${vectorPath}.bak.`)
    );
    expect(state.isVectorDBReady).toBe(true);
    expect(state.colorTable).not.toBe(oldColorTable);
    expect(await state.photoTable?.countRows()).toBe(0);
    expect(await fsPromises.readFile(original, "utf8")).toBe(
      "preserve this original"
    );
  });

  it("reports an unrecoverable cleanup error and allows a later retry", async () => {
    const [state, vectorDb] = await Promise.all([
      import("@/services/ai/state"),
      import("@/services/ai/vector-db"),
    ]);
    await vectorDb.initVectorDB();
    const vectorPath = path.join(testPaths.dataPath, "vectors");
    const remove = fs.promises.rm.bind(fs.promises);
    const removeSpy = vi
      .spyOn(fs.promises, "rm")
      .mockImplementation(async (target, options) => {
        if (String(target) === vectorPath) {
          throw Object.assign(new Error("directory still locked"), {
            code: "ENOTEMPTY",
          });
        }
        await remove(target, options);
      });
    const renameSpy = vi
      .spyOn(fs.promises, "rename")
      .mockRejectedValueOnce(new Error("rename denied"));
    expect(await vectorDb.rebuildVectorDB()).toEqual({
      success: false,
      error: "rename denied",
    });
    expect(state.isVectorDBReady).toBe(false);
    expect(state.photoTable).toBeNull();
    expect(state.colorTable).toBeNull();
    removeSpy.mockRestore();
    renameSpy.mockRestore();
    expect(await vectorDb.rebuildVectorDB()).toEqual({ success: true });
    expect(state.isVectorDBReady).toBe(true);
  });

  it.runIf(
    fs.existsSync(
      path.join(
        process.cwd(),
        "models",
        "Xenova",
        "siglip-base-patch16-224",
        "onnx",
        "vision_model_quantized.onnx"
      )
    )
  )(
    "preserves verified adoption for the exact historical runtime identity",
    async () => {
      const [adapterModule, fingerprintModule, state, vectorDb] =
        await Promise.all([
          import("@/services/ai/model-adapter"),
          import("@/services/ai/model-fingerprint"),
          import("@/services/ai/state"),
          import("@/services/ai/vector-db"),
        ]);
      const legacyAdapter = structuredClone(adapterModule.SIGLIP_V1_ADAPTER);
      legacyAdapter.embeddingSpace.image.preprocessingVersion =
        "siglip-lanczos3-v1";
      legacyAdapter.thresholdProfileId = "siglip-v1-base-patch16-224-default";
      adapterModule.registerEmbeddingAdapter(legacyAdapter);
      // The current fingerprint generator represents v2 only. Simulate the
      // historical runtime identity; artifact hashes, LanceDB and adoption
      // persistence remain real and the adapter registry is restored afterward.
      vi.spyOn(fingerprintModule, "getModelFingerprint").mockReturnValue(
        fingerprintModule.SIGLIP_LEGACY_FINGERPRINT
      );
      const dimensions = legacyAdapter.embeddingSpace.dimensions;
      await vectorDb.initVectorDB();
      await state.photoTable?.add([
        {
          photo_id: 1,
          vector: normalizedVector(dimensions),
          created_at: Date.now(),
        },
      ]);
      await vectorDb.persistActiveVectorFingerprint("fresh-build");
      await vectorDb.closeVectorDB();
      const markerPath = fingerprintModule.getVectorFingerprintPath(
        testPaths.dataPath
      );
      await fsPromises.rename(markerPath, `${markerPath}.historical-fixture`);

      await vectorDb.initVectorDB();
      expect(state.getActiveEmbeddingRuntime()?.vectorCompatibility).toBe(
        "legacy-compatible"
      );
      expect(await state.photoTable?.countRows()).toBe(1);
      expect(
        fingerprintModule.readStoredVectorFingerprint(testPaths.dataPath)
      ).toMatchObject({
        fingerprint: fingerprintModule.SIGLIP_LEGACY_FINGERPRINT,
        source: "legacy-adoption",
        buildState: "ready",
      });
    }
  );
});
