import path from "node:path";

export type EmbeddingAdapterFamily = "siglip";
export type EmbeddingAdapterId = string;
export type EmbeddingNormalization = "l2";
export type WorkerExecutionProvider = "cpu" | "directml";

export interface ModelArtifactSpec {
  relativePath: string;
  required: boolean;
  sha256: string;
  sizeBytes: number;
}

export interface ImageEmbeddingSpec {
  dimensions: number;
  imageSize: number;
  inputName: string;
  mean: readonly [number, number, number];
  modelRelativePath: string;
  outputName: string;
  resizeFit: "fill" | "contain" | "cover";
  std: readonly [number, number, number];
}

export interface TextEmbeddingSpec {
  dimensions: number;
  engine: "transformers-js" | "onnxruntime-node";
  inputNames?: {
    inputIds?: string;
    attentionMask?: string;
  };
  maxLength: number;
  modelRelativePath: string;
  outputName: string;
  padding: "max_length";
  tokenizerRelativePath?: string;
}

export interface EmbeddingAdapterDescriptor {
  artifacts: ModelArtifactSpec[];
  capabilities: {
    imageToImage: boolean;
    textToImage: boolean;
    tagging: boolean;
    duplicateDetection: boolean;
  };
  displayName: string;
  embeddingSpace: {
    dimensions: number;
    normalization: EmbeddingNormalization;
    image: ImageEmbeddingSpec;
    text: TextEmbeddingSpec;
  };
  family: EmbeddingAdapterFamily;
  id: EmbeddingAdapterId;
  legacyKind?: "siglip";
  modelId: string;
  revision: string;
  schemaVersion: 1;
  thresholdProfileId: string;
}

export interface SerializedWorkerAdapter {
  adapterId: EmbeddingAdapterId;
  fingerprint: string;
  image: ImageEmbeddingSpec;
  modelId: string;
  modelRoot: string;
  normalization: EmbeddingNormalization;
  protocolVersion: 1;
  text: TextEmbeddingSpec;
}

const V1_ARTIFACTS: ModelArtifactSpec[] = [
  {
    relativePath:
      "Xenova/siglip-base-patch16-224/onnx/vision_model_quantized.onnx",
    sha256: "ef14a954f3d57e1806666432bd9785004c1dc27100aa260eee0cb0f10a5de058",
    sizeBytes: 99_499_129,
    required: true,
  },
  {
    relativePath:
      "Xenova/siglip-base-patch16-224/onnx/text_model_quantized.onnx",
    sha256: "ad0329b1f35acc66d8953ff2559ce358da8eb0a7011794cf951523d63a4dbce2",
    sizeBytes: 111_475_220,
    required: true,
  },
  {
    relativePath: "Xenova/siglip-base-patch16-224/config.json",
    sha256: "e6de71291f181b0b81adc93098787bb4597a79dc18f59737feda8f41671fb6a2",
    sizeBytes: 457,
    required: true,
  },
  {
    relativePath: "Xenova/siglip-base-patch16-224/preprocessor_config.json",
    sha256: "21ee046a8a52a65e5f9c177bf840bfb39ea66c9c54cf2760630efd58e0a3ec80",
    sizeBytes: 368,
    required: true,
  },
  {
    relativePath: "Xenova/siglip-base-patch16-224/special_tokens_map.json",
    sha256: "22f82d1c19654c9552ff1368c2c236ebb34f457dbdbc7510d304cebfeb96f3bf",
    sizeBytes: 406,
    required: true,
  },
  {
    relativePath: "Xenova/siglip-base-patch16-224/spiece.model",
    sha256: "1e5036bed065526c3c212dfbe288752391797c4bb1a284aa18c9a0b23fcaf8ec",
    sizeBytes: 798_330,
    required: true,
  },
  {
    relativePath: "Xenova/siglip-base-patch16-224/tokenizer.json",
    sha256: "4a17c975210be5ab4c36b47d8dae4eefb866dbfb1e676e394aad85dc30a3ae08",
    sizeBytes: 2_398_744,
    required: true,
  },
  {
    relativePath: "Xenova/siglip-base-patch16-224/tokenizer_config.json",
    sha256: "9a38d3c6b5e26fe5dcc607eda95e38d78d30d9291835bb9e8116e8174c1d4ba2",
    sizeBytes: 739,
    required: true,
  },
];

export const SIGLIP_V1_ADAPTER_ID = "siglip-v1-base-patch16-224";

export const SIGLIP_V1_ADAPTER: EmbeddingAdapterDescriptor = {
  schemaVersion: 1,
  id: SIGLIP_V1_ADAPTER_ID,
  legacyKind: "siglip",
  family: "siglip",
  displayName: "SigLIP Base Patch16-224",
  modelId: "Xenova/siglip-base-patch16-224",
  revision: "main",
  artifacts: V1_ARTIFACTS,
  embeddingSpace: {
    dimensions: 768,
    normalization: "l2",
    image: {
      modelRelativePath:
        "Xenova/siglip-base-patch16-224/onnx/vision_model_quantized.onnx",
      inputName: "pixel_values",
      outputName: "pooler_output",
      dimensions: 768,
      imageSize: 224,
      resizeFit: "fill",
      mean: [0.5, 0.5, 0.5],
      std: [0.5, 0.5, 0.5],
    },
    text: {
      engine: "transformers-js",
      modelRelativePath:
        "Xenova/siglip-base-patch16-224/onnx/text_model_quantized.onnx",
      tokenizerRelativePath: "Xenova/siglip-base-patch16-224/tokenizer.json",
      outputName: "pooler_output",
      dimensions: 768,
      maxLength: 64,
      padding: "max_length",
    },
  },
  capabilities: {
    imageToImage: true,
    textToImage: true,
    tagging: true,
    duplicateDetection: true,
  },
  thresholdProfileId: "siglip-v1-base-patch16-224-default",
};

const adapterRegistry = new Map<EmbeddingAdapterId, EmbeddingAdapterDescriptor>(
  [[SIGLIP_V1_ADAPTER.id, SIGLIP_V1_ADAPTER]]
);

let activeAdapterId = SIGLIP_V1_ADAPTER_ID;

export function registerEmbeddingAdapter(
  adapter: EmbeddingAdapterDescriptor
): void {
  if (adapter.schemaVersion !== 1) {
    throw new Error(
      `Unsupported embedding adapter schema: ${adapter.schemaVersion}`
    );
  }
  if (!adapter.id.trim()) {
    throw new Error("Embedding adapter id must not be empty");
  }
  if (
    adapter.embeddingSpace.dimensions !==
      adapter.embeddingSpace.image.dimensions ||
    adapter.embeddingSpace.dimensions !== adapter.embeddingSpace.text.dimensions
  ) {
    throw new Error(
      `Embedding adapter ${adapter.id} has inconsistent dimensions`
    );
  }
  adapterRegistry.set(adapter.id, adapter);
}

export function getEmbeddingAdapter(
  id: EmbeddingAdapterId
): EmbeddingAdapterDescriptor {
  const adapter = adapterRegistry.get(id);
  if (!adapter) {
    throw new Error(`Unknown embedding adapter: ${id}`);
  }
  return adapter;
}

export function getActiveEmbeddingAdapter(): EmbeddingAdapterDescriptor {
  return getEmbeddingAdapter(activeAdapterId);
}

export function getActiveEmbeddingAdapterInfo(): {
  adapterId: string;
  displayName: string;
  modelId: string;
  revision: string;
} {
  const adapter = getActiveEmbeddingAdapter();
  return {
    adapterId: adapter.id,
    displayName: adapter.displayName,
    modelId: adapter.modelId,
    revision: adapter.revision,
  };
}

export function setActiveEmbeddingAdapter(id: EmbeddingAdapterId): void {
  getEmbeddingAdapter(id);
  activeAdapterId = id;
}

export function serializeEmbeddingAdapter(
  adapter: EmbeddingAdapterDescriptor,
  fingerprint: string,
  modelRoot: string
): SerializedWorkerAdapter {
  return {
    protocolVersion: 1,
    adapterId: adapter.id,
    fingerprint,
    modelRoot: path.resolve(modelRoot),
    modelId: adapter.modelId,
    image: { ...adapter.embeddingSpace.image },
    text: { ...adapter.embeddingSpace.text },
    normalization: adapter.embeddingSpace.normalization,
  };
}
