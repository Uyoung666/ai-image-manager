import { afterEach, describe, expect, it } from "vitest";
import {
  getActiveEmbeddingModel,
  getEmbeddingModelFile,
} from "@/services/ai/model-config";

const originalModel = process.env.AI_EMBEDDING_MODEL;

afterEach(() => {
  if (originalModel === undefined) {
    delete process.env.AI_EMBEDDING_MODEL;
  } else {
    process.env.AI_EMBEDDING_MODEL = originalModel;
  }
});

describe("embedding model configuration", () => {
  it("uses SigLIP as the upgraded default", () => {
    delete process.env.AI_EMBEDDING_MODEL;

    expect(getActiveEmbeddingModel()).toMatchObject({
      kind: "siglip",
      modelId: "Xenova/siglip-base-patch16-224",
      vectorDimensions: 768,
    });
  });

  it("keeps CLIP as an explicit rollback option", () => {
    process.env.AI_EMBEDDING_MODEL = "clip";

    expect(getActiveEmbeddingModel()).toMatchObject({
      kind: "clip",
      modelId: "Xenova/clip-vit-base-patch32",
      vectorDimensions: 512,
    });
  });

  it("resolves the active model marker under the supplied model root", () => {
    delete process.env.AI_EMBEDDING_MODEL;

    expect(
      getEmbeddingModelFile("D:\\models", "vision_model_quantized.onnx")
    ).toContain(
      "Xenova\\siglip-base-patch16-224\\onnx\\vision_model_quantized.onnx"
    );
  });
});
