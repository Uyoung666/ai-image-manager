import { afterEach, describe, expect, it } from "vitest";
import { getActiveFaceModel } from "@/services/ai/face-model-config";

afterEach(() => {
  delete process.env.FACE_MODEL_KIND;
  delete process.env.FACE_MODEL_ALLOW_RESEARCH_ONLY;
});

describe("getActiveFaceModel", () => {
  it("defaults to yunet-sface (128-d, landmark align)", () => {
    delete process.env.FACE_MODEL_KIND;
    const m = getActiveFaceModel();
    expect(m.kind).toBe("yunet-sface");
    expect(m.recognition.vectorDimensions).toBe(128);
    expect(m.recognition.useLandmarkAlign).toBe(true);
    expect(m.detection.confidenceThreshold).toBe(0.85);
    expect(m.clustering.confidenceFilter).toBe(0.85);
  });

  it("keeps the legacy model disabled without an explicit research opt-in", () => {
    process.env.FACE_MODEL_KIND = "ultraface-w600k";
    expect(getActiveFaceModel().kind).toBe("yunet-sface");
  });

  it("switches to ultraface-w600k only with explicit research opt-in", () => {
    process.env.FACE_MODEL_KIND = "ultraface-w600k";
    process.env.FACE_MODEL_ALLOW_RESEARCH_ONLY = "1";
    const m = getActiveFaceModel();
    expect(m.kind).toBe("ultraface-w600k");
    expect(m.recognition.vectorDimensions).toBe(512);
    expect(m.recognition.useLandmarkAlign).toBe(false);
    expect(m.clustering.threshold).toBe(0.55);
  });

  it("ignores unknown values and falls back to the default", () => {
    process.env.FACE_MODEL_KIND = "bogus-kind";
    expect(getActiveFaceModel().kind).toBe("yunet-sface");
  });
});
