import path from "node:path";

export type EmbeddingModelKind = "siglip";

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
  semanticSearch?: {
    absoluteMinimumSimilarity: number;
    candidateMinimumSimilarity: number;
    consensusThresholdRatio: number;
    relativeToTopRatio: number;
  };
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
      semanticSearch: {
        absoluteMinimumSimilarity: 0.04,
        candidateMinimumSimilarity: 0.02,
        consensusThresholdRatio: 0.75,
        relativeToTopRatio: 0.4,
      },
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
  // Keep the environment variable backwards-compatible without allowing it
  // to select a removed/non-commercial model.
  return MODEL_CONFIGS.siglip;
}

export type SemanticPolicyVersion = "legacy" | "v2";

export function getSemanticPolicyVersion(): SemanticPolicyVersion {
  return process.env.AI_SEMANTIC_POLICY?.trim().toLowerCase() === "legacy"
    ? "legacy"
    : "v2";
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

export function getTranslationModelFile(
  modelsRoot: string,
  fileName:
    | "decoder_model_merged_quantized.onnx"
    | "encoder_model_quantized.onnx"
): string {
  return path.join(modelsRoot, "Xenova", "opus-mt-zh-en", "onnx", fileName);
}
