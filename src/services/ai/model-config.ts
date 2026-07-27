import path from "node:path";

export type EmbeddingModelKind = "clip" | "siglip";

export interface EmbeddingModelConfig {
  directory: string;
  displayName: string;
  imageMean: readonly [number, number, number];
  imageOutputName: "image_embeds" | "pooler_output";
  imageSize: number;
  imageStd: readonly [number, number, number];
  kind: EmbeddingModelKind;
  modelId: string;
  scoring: EmbeddingScoringPolicy;
  textOutputName: "pooler_output" | "text_embeds";
  vectorDimensions: number;
}

export interface EmbeddingScoringPolicy {
  duplicateConfirmationSimilarity: number;
  englishTextMaxCosineDistance: number;
  tag?: {
    candidateFromMedian: number;
    candidateFromTop: number;
    confidenceMax: number;
    confidenceMin: number;
    topFromMedian: number;
    topMinimum: number;
  };
  textMaxCosineDistanceAtFullCoverage: number;
  textMaxCosineDistanceAtNoCoverage: number;
}

const MODEL_CONFIGS: Record<EmbeddingModelKind, EmbeddingModelConfig> = {
  clip: {
    kind: "clip",
    modelId: "Xenova/clip-vit-base-patch32",
    directory: "clip-vit-base-patch32",
    displayName: "CLIP ViT-B/32",
    vectorDimensions: 512,
    imageSize: 224,
    imageMean: [0.481_454_66, 0.457_827_5, 0.408_210_73],
    imageStd: [0.268_629_54, 0.261_302_58, 0.275_777_11],
    imageOutputName: "image_embeds",
    textOutputName: "text_embeds",
    scoring: {
      duplicateConfirmationSimilarity: 0.95,
      englishTextMaxCosineDistance: 0.75,
      textMaxCosineDistanceAtNoCoverage: 0.22,
      textMaxCosineDistanceAtFullCoverage: 0.55,
    },
  },
  siglip: {
    kind: "siglip",
    modelId: "Xenova/siglip-base-patch16-224",
    directory: "siglip-base-patch16-224",
    displayName: "SigLIP Base Patch16-224",
    vectorDimensions: 768,
    imageSize: 224,
    imageMean: [0.5, 0.5, 0.5],
    imageStd: [0.5, 0.5, 0.5],
    imageOutputName: "pooler_output",
    textOutputName: "pooler_output",
    scoring: {
      duplicateConfirmationSimilarity: 0.95,
      englishTextMaxCosineDistance: 0.98,
      textMaxCosineDistanceAtNoCoverage: 0.98,
      textMaxCosineDistanceAtFullCoverage: 0.98,
      tag: {
        candidateFromMedian: 0.02,
        candidateFromTop: 0.04,
        confidenceMax: 0.95,
        confidenceMin: 0.55,
        topFromMedian: 0.03,
        topMinimum: 0.035,
      },
    },
  },
};

export function getActiveEmbeddingModel(): EmbeddingModelConfig {
  const requested = process.env.AI_EMBEDDING_MODEL?.trim().toLowerCase();
  return requested === "clip" ? MODEL_CONFIGS.clip : MODEL_CONFIGS.siglip;
}

export function getTextSearchMaxCosineDistance(
  coverage: number,
  language: "en" | "zh"
): number {
  const { scoring } = getActiveEmbeddingModel();
  if (language === "en") {
    return scoring.englishTextMaxCosineDistance;
  }
  const safeCoverage = Math.max(0, Math.min(1, coverage));
  return (
    scoring.textMaxCosineDistanceAtNoCoverage +
    safeCoverage *
      (scoring.textMaxCosineDistanceAtFullCoverage -
        scoring.textMaxCosineDistanceAtNoCoverage)
  );
}

export function getEmbeddingModelFile(
  modelsRoot: string,
  fileName: "text_model_quantized.onnx" | "vision_model_quantized.onnx"
): string {
  const model = getActiveEmbeddingModel();
  return path.join(modelsRoot, "Xenova", model.directory, "onnx", fileName);
}
