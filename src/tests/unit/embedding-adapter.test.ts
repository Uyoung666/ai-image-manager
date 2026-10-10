import { describe, expect, it } from "vitest";
import {
  getActiveEmbeddingAdapter,
  getActiveEmbeddingAdapterInfo,
  registerEmbeddingAdapter,
  SIGLIP_V1_ADAPTER,
  serializeEmbeddingAdapter,
} from "@/services/ai/model-adapter";
import { getActiveEmbeddingWorkerAdapter } from "@/services/ai/model-config";
import {
  buildModelFingerprintPayload,
  canonicalJson,
  getModelFingerprint,
} from "@/services/ai/model-fingerprint";
import {
  getActiveThresholdProfile,
  getDuplicateThreshold,
  getTagThresholds,
  getTextSearchThreshold,
  resolveThresholdProfile,
  SIGLIP_BICUBIC_FINGERPRINT,
} from "@/services/ai/threshold-profile";

describe("embedding adapter contracts", () => {
  it("registers SigLIP with explicit Processor-aligned image preprocessing", () => {
    const adapter = getActiveEmbeddingAdapter();
    expect(adapter.id).toBe("siglip-v1-base-patch16-224");
    expect(adapter.legacyKind).toBe("siglip");
    expect(adapter.embeddingSpace.dimensions).toBe(768);
    expect(adapter.embeddingSpace.image.imageSize).toBe(224);
    expect(adapter.embeddingSpace.image).toMatchObject({
      colorMode: "rgb",
      preprocessingVersion: "siglip-bicubic-rgb-v2",
      resample: "bicubic",
      rescaleFactor: 1 / 255,
    });
    expect(adapter.embeddingSpace.image.outputName).toBe("pooler_output");
    expect(adapter.embeddingSpace.text.outputName).toBe("pooler_output");
    expect(getActiveEmbeddingAdapterInfo()).toMatchObject({
      adapterId: adapter.id,
      modelId: adapter.modelId,
    });
  });

  it("creates stable fingerprints independent of object key order", () => {
    const first = canonicalJson({ b: 2, a: { d: 4, c: 3 } });
    const second = canonicalJson({ a: { c: 3, d: 4 }, b: 2 });
    expect(first).toBe(second);
    expect(getModelFingerprint(SIGLIP_V1_ADAPTER)).toBe(
      getModelFingerprint(SIGLIP_V1_ADAPTER)
    );
  });

  it("changes fingerprint when embedding behavior changes", () => {
    const changed = structuredClone(SIGLIP_V1_ADAPTER);
    changed.embeddingSpace.image.imageSize = 336;
    expect(getModelFingerprint(changed)).not.toBe(
      getModelFingerprint(SIGLIP_V1_ADAPTER)
    );

    const tokenizerChanged = structuredClone(SIGLIP_V1_ADAPTER);
    tokenizerChanged.embeddingSpace.text.tokenizerRelativePath =
      "Xenova/other-tokenizer.json";
    expect(getModelFingerprint(tokenizerChanged)).not.toBe(
      getModelFingerprint(SIGLIP_V1_ADAPTER)
    );
    const preprocessingChanged = structuredClone(SIGLIP_V1_ADAPTER);
    preprocessingChanged.embeddingSpace.image.preprocessingVersion = "next";
    expect(getModelFingerprint(preprocessingChanged)).not.toBe(
      getModelFingerprint(SIGLIP_V1_ADAPTER)
    );

    const payload = buildModelFingerprintPayload(SIGLIP_V1_ADAPTER);
    expect(payload).not.toHaveProperty("thresholdProfileId");
    expect(payload).not.toHaveProperty("displayName");
  });

  it("serializes the adapter for workers without absolute model identity", () => {
    const workerAdapter = serializeEmbeddingAdapter(
      SIGLIP_V1_ADAPTER,
      getModelFingerprint(SIGLIP_V1_ADAPTER),
      "D:\\models"
    );
    expect(workerAdapter).toMatchObject({
      adapterId: SIGLIP_V1_ADAPTER.id,
      modelRoot: "D:\\models",
      image: {
        inputName: "pixel_values",
        dimensions: 768,
      },
      text: {
        engine: "transformers-js",
        dimensions: 768,
      },
    });
  });

  it("keeps unchanged thresholds pending validation for the new vector space", () => {
    const profile = getActiveThresholdProfile();
    expect(profile.calibrationStatus).toBe("pending-validation");
    expect(profile.modelFingerprint).toBe(
      getModelFingerprint(SIGLIP_V1_ADAPTER)
    );
    expect(getDuplicateThreshold()).toBe(0.95);
    expect(getTextSearchThreshold(0, "zh")).toBe(0.98);
    expect(getTextSearchThreshold(1, "en")).toBe(0.98);
    expect(getTagThresholds().topMinimum).toBe(0.035);
    expect(profile.modelFingerprint).toBe(SIGLIP_BICUBIC_FINGERPRINT);
  });

  it("does not transfer a calibration identity to altered preprocessing", () => {
    const changed = structuredClone(SIGLIP_V1_ADAPTER);
    changed.id = "siglip-future-preprocessing-test";
    changed.embeddingSpace.image.preprocessingVersion = "next";
    registerEmbeddingAdapter(changed);
    expect(
      resolveThresholdProfile(changed.id, getModelFingerprint(changed))
    ).toBeNull();
  });

  it("uses the same worker identity through the model-config compatibility API", () => {
    const workerAdapter = getActiveEmbeddingWorkerAdapter("D:\\models");
    expect(workerAdapter.adapterId).toBe(SIGLIP_V1_ADAPTER.id);
    expect(workerAdapter.fingerprint).toBe(
      getModelFingerprint(SIGLIP_V1_ADAPTER)
    );
  });
});
