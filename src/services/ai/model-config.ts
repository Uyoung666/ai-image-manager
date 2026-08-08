import path from "node:path";
import {
  type EmbeddingAdapterDescriptor,
  getActiveEmbeddingAdapter,
  getActiveEmbeddingAdapterInfo,
  serializeEmbeddingAdapter,
} from "./model-adapter";
import {
  getActiveEmbeddingFingerprint,
  getModelFingerprint,
} from "./model-fingerprint";
import {
  getActiveThresholdProfile,
  getTextSearchThreshold,
} from "./threshold-profile";

const PATH_SPLIT_RE = /[\\/]/u;

export type EmbeddingModelKind = "siglip";

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

/**
 * Legacy view retained for existing callers and persisted diagnostics.
 * New code should use EmbeddingAdapterDescriptor and ThresholdProfile.
 */
export interface EmbeddingModelConfig {
  adapterId: string;
  directory: string;
  displayName: string;
  imageMean: readonly [number, number, number];
  imageOutputName: string;
  imageSize: number;
  imageStd: readonly [number, number, number];
  kind: EmbeddingModelKind;
  modelId: string;
  revision: string;
  scoring: EmbeddingScoringPolicy;
  textOutputName: string;
  vectorDimensions: number;
}

function toLegacyScoring(): EmbeddingScoringPolicy {
  const profile = getActiveThresholdProfile();
  return {
    duplicateConfirmationSimilarity: profile.duplicate.confirmationSimilarity,
    englishTextMaxCosineDistance: profile.textDistance.englishMaxCosineDistance,
    semanticSearch: { ...profile.semanticSearch },
    tag: { ...profile.tag },
    textMaxCosineDistanceAtFullCoverage:
      profile.textDistance.fullCoverageMaxCosineDistance,
    textMaxCosineDistanceAtNoCoverage:
      profile.textDistance.noCoverageMaxCosineDistance,
  };
}

function getDirectory(adapter: EmbeddingAdapterDescriptor): string {
  const marker = "Xenova/";
  const relativePath = adapter.embeddingSpace.image.modelRelativePath;
  const normalized = relativePath.replaceAll("\\", "/");
  const onnxIndex = normalized.indexOf("/onnx/");
  const modelPath =
    onnxIndex >= 0 ? normalized.slice(0, onnxIndex) : normalized;
  return modelPath.startsWith(marker)
    ? modelPath.slice(marker.length)
    : modelPath;
}

function toLegacyModel(
  adapter: EmbeddingAdapterDescriptor
): EmbeddingModelConfig {
  const image = adapter.embeddingSpace.image;
  const text = adapter.embeddingSpace.text;
  return {
    adapterId: adapter.id,
    directory: getDirectory(adapter),
    displayName: adapter.displayName,
    imageMean: image.mean,
    imageOutputName: image.outputName,
    imageSize: image.imageSize,
    imageStd: image.std,
    kind: adapter.legacyKind ?? "siglip",
    modelId: adapter.modelId,
    revision: adapter.revision,
    scoring: toLegacyScoring(),
    textOutputName: text.outputName,
    vectorDimensions: adapter.embeddingSpace.dimensions,
  };
}

export function getActiveEmbeddingModel(): EmbeddingModelConfig {
  return toLegacyModel(getActiveEmbeddingAdapter());
}

export function getActiveEmbeddingAdapterFingerprint(): string {
  return getActiveEmbeddingFingerprint();
}

export function getActiveEmbeddingWorkerAdapter(modelRoot: string) {
  const adapter = getActiveEmbeddingAdapter();
  return serializeEmbeddingAdapter(
    adapter,
    getModelFingerprint(adapter),
    modelRoot
  );
}

export function getActiveEmbeddingRuntimeInfo(): {
  adapterId: string;
  displayName: string;
  modelId: string;
  revision: string;
  fingerprint: string;
  dimensions: number;
  thresholdProfileId: string;
} {
  const adapter = getActiveEmbeddingAdapter();
  const info = getActiveEmbeddingAdapterInfo();
  const profile = getActiveThresholdProfile();
  return {
    ...info,
    fingerprint: getModelFingerprint(adapter),
    dimensions: adapter.embeddingSpace.dimensions,
    thresholdProfileId: profile.profileId,
  };
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
  return getTextSearchThreshold(coverage, language);
}

export function getEmbeddingModelFile(
  modelsRoot: string,
  fileName: "text_model_quantized.onnx" | "vision_model_quantized.onnx"
): string {
  const adapter = getActiveEmbeddingAdapter();
  const relativePath =
    fileName === "vision_model_quantized.onnx"
      ? adapter.embeddingSpace.image.modelRelativePath
      : adapter.embeddingSpace.text.modelRelativePath;
  return path.join(modelsRoot, ...relativePath.split(PATH_SPLIT_RE));
}

export function getTranslationModelFile(
  modelsRoot: string,
  fileName:
    | "decoder_model_merged_quantized.onnx"
    | "encoder_model_quantized.onnx"
): string {
  return path.join(modelsRoot, "Xenova", "opus-mt-zh-en", "onnx", fileName);
}
