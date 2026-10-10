import type { ImageEmbeddingSpec } from "../src/services/ai/model-adapter";

export function preprocessImage(
  input: string | Buffer,
  image: ImageEmbeddingSpec
): Promise<Float32Array>;
