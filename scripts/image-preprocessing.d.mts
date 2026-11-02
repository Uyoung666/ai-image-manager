import type { ImageEmbeddingSpec } from "../src/services/ai/model-adapter";

export function preprocessImage(
  input: string | Buffer,
  image: ImageEmbeddingSpec,
  options?: {
    cacheDir?: string;
    onTimings?: (timings: Record<string, number | boolean>) => void;
  }
): Promise<Float32Array>;
