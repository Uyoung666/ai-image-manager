import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type EmbeddingAdapterDescriptor,
  SIGLIP_V1_ADAPTER,
} from "@/services/ai/model-adapter";
import {
  decideVectorCompatibility,
  getModelFingerprint,
  getVectorFingerprintPath,
  inspectStoredVectorFingerprint,
  isVectorCompatibilitySearchable,
  readStoredVectorFingerprint,
  resolveRuntimeVectorCompatibility,
  type StoredVectorFingerprint,
  shouldPublishVectorFingerprint,
  type VectorCompatibilityDecisionInput,
  type VectorCompatibilityIdentity,
  type VectorFingerprintMarker,
} from "@/services/ai/model-fingerprint";

const tempPaths: string[] = [];

function activeIdentity(
  adapter: EmbeddingAdapterDescriptor = SIGLIP_V1_ADAPTER
): VectorCompatibilityIdentity {
  return {
    adapterId: adapter.id,
    dimensions: adapter.embeddingSpace.dimensions,
    fingerprint: getModelFingerprint(adapter),
    legacyKind: adapter.legacyKind,
  };
}

function storedFingerprint(
  overrides: Partial<StoredVectorFingerprint> = {}
): StoredVectorFingerprint {
  const active = activeIdentity();
  return {
    schemaVersion: 1,
    adapterId: active.adapterId,
    createdAt: "2026-08-08T00:00:00.000Z",
    dimensions: active.dimensions,
    fingerprint: active.fingerprint,
    source: "fresh-build",
    ...overrides,
  };
}

function validMarker(
  overrides: Partial<StoredVectorFingerprint> = {}
): VectorFingerprintMarker {
  return { state: "valid", value: storedFingerprint(overrides) };
}

function decide(overrides: Partial<VectorCompatibilityDecisionInput> = {}) {
  const active = activeIdentity();
  return decideVectorCompatibility({
    active,
    legacyArtifactsVerified: false,
    marker: { state: "missing" },
    rowCount: 1,
    vectorDimensions: active.dimensions,
    ...overrides,
  });
}

function createMarkerDirectory(): string {
  const dataPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "ai-image-manager-vector-fingerprint-")
  );
  tempPaths.push(dataPath);
  fs.mkdirSync(path.dirname(getVectorFingerprintPath(dataPath)), {
    recursive: true,
  });
  return dataPath;
}

afterEach(() => {
  for (const tempPath of tempPaths.splice(0)) {
    fs.rmSync(tempPath, { recursive: true, force: true });
  }
});

describe("vector fingerprint compatibility decisions", () => {
  it.each([
    {
      expected: "empty",
      input: { marker: { state: "missing" } as const, rowCount: 0 },
    },
    {
      expected: "matching",
      input: { marker: validMarker() },
    },
    {
      expected: "legacy-compatible",
      input: {
        legacyArtifactsVerified: true,
        marker: { state: "missing" } as const,
      },
    },
    {
      expected: "missing-fingerprint",
      input: { marker: { state: "missing" } as const },
    },
    {
      expected: "fingerprint-mismatch",
      input: { marker: validMarker({ fingerprint: "b".repeat(64) }) },
    },
    {
      expected: "invalid-fingerprint",
      input: { marker: { state: "invalid" } as const },
    },
    {
      expected: "dimension-mismatch",
      input: { marker: validMarker({ dimensions: 512 }) },
    },
  ])("classifies $expected", ({ expected, input }) => {
    expect(decide(input).status).toBe(expected);
  });

  it("rejects a vector schema dimension that differs from the active adapter", () => {
    expect(
      decide({
        marker: validMarker(),
        vectorDimensions: SIGLIP_V1_ADAPTER.embeddingSpace.dimensions - 1,
      })
    ).toEqual({ status: "dimension-mismatch", adoptLegacy: false });
  });

  it("recognizes A to B to A switches against the same stored marker", () => {
    const adapterA = structuredClone(SIGLIP_V1_ADAPTER);
    const adapterB = structuredClone(SIGLIP_V1_ADAPTER);
    adapterB.id = "siglip-v1-test-adapter-b";
    adapterB.revision = "test-revision-b";
    const marker = validMarker();

    const sequence = [adapterA, adapterB, adapterA].map(
      (adapter) => decide({ active: activeIdentity(adapter), marker }).status
    );

    expect(sequence).toEqual(["matching", "fingerprint-mismatch", "matching"]);
  });

  it("does not include threshold changes in the embedding fingerprint", () => {
    const changedThreshold = structuredClone(SIGLIP_V1_ADAPTER);
    changedThreshold.thresholdProfileId = "siglip-v1-test-threshold-profile";

    expect(getModelFingerprint(changedThreshold)).toBe(
      getModelFingerprint(SIGLIP_V1_ADAPTER)
    );
  });

  it("adopts a verified legacy store without requesting a rebuild", () => {
    const decision = decide({
      legacyArtifactsVerified: true,
      marker: { state: "missing" },
    });

    expect(decision).toEqual({
      status: "legacy-compatible",
      adoptLegacy: true,
    });
    expect(isVectorCompatibilitySearchable(decision.status)).toBe(true);
  });

  it.each([
    ["failed index", { indexReady: false }],
    ["cancelled run", { runWritable: false }],
    ["partial run", { processed: 20, total: 21 }],
    ["failed run", { processed: 0 }],
    ["missing table", { hasVectorTable: false }],
  ])("does not publish a fingerprint after a %s", (_name, overrides) => {
    expect(
      shouldPublishVectorFingerprint({
        hasVectorTable: true,
        indexReady: true,
        processed: 21,
        runWritable: true,
        total: 21,
        ...overrides,
      })
    ).toBe(false);
  });

  it("publishes a fingerprint only after a complete writable indexed run", () => {
    expect(
      shouldPublishVectorFingerprint({
        hasVectorTable: true,
        indexReady: true,
        processed: 21,
        runWritable: true,
        total: 21,
      })
    ).toBe(true);
  });
});

describe("stored vector fingerprint marker inspection", () => {
  it("distinguishes a missing marker", () => {
    const dataPath = createMarkerDirectory();

    expect(inspectStoredVectorFingerprint(dataPath)).toEqual({
      state: "missing",
    });
    expect(readStoredVectorFingerprint(dataPath)).toBeNull();
  });

  it.each([
    ["damaged JSON", "{not-json"],
    [
      "missing field",
      JSON.stringify({
        ...storedFingerprint(),
        createdAt: undefined,
      }),
    ],
    [
      "illegal hash",
      JSON.stringify(storedFingerprint({ fingerprint: "NOT-A-SHA256" })),
    ],
  ])("marks %s as invalid", (_name, contents) => {
    const dataPath = createMarkerDirectory();
    fs.writeFileSync(getVectorFingerprintPath(dataPath), contents, "utf-8");

    expect(inspectStoredVectorFingerprint(dataPath)).toEqual({
      state: "invalid",
    });
    expect(readStoredVectorFingerprint(dataPath)).toBeNull();
  });

  it("reads a complete valid marker", () => {
    const dataPath = createMarkerDirectory();
    const stored = storedFingerprint({ source: "legacy-adoption" });
    fs.writeFileSync(
      getVectorFingerprintPath(dataPath),
      JSON.stringify(stored),
      "utf-8"
    );

    expect(inspectStoredVectorFingerprint(dataPath)).toEqual({
      state: "valid",
      value: stored,
    });
    expect(readStoredVectorFingerprint(dataPath)).toEqual(stored);
  });
});

describe("runtime vector identity compatibility", () => {
  it("blocks stale runtime identities and accepts the restored identity", () => {
    const active = activeIdentity();
    const staleRuntime = { ...active, fingerprint: "c".repeat(64) };

    const mismatch = resolveRuntimeVectorCompatibility(
      active,
      staleRuntime,
      "matching"
    );
    const restored = resolveRuntimeVectorCompatibility(
      active,
      active,
      "matching"
    );

    expect(mismatch).toBe("fingerprint-mismatch");
    expect(isVectorCompatibilitySearchable(mismatch)).toBe(false);
    expect(restored).toBe("matching");
    expect(isVectorCompatibilitySearchable(restored)).toBe(true);
  });
});
