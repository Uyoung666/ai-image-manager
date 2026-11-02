import type { Sharp, Metadata } from "sharp";
import type { ImageEmbeddingSpec } from "../src/services/ai/model-adapter";
export function orientPixels(pipeline: Sharp, orientation: number): Sharp;
export function resizeModelRgb(
  decoder: Sharp,
  metadata: Pick<
    Metadata,
    "orientation" | "width" | "height" | "hasAlpha" | "space"
  >,
  image: ImageEmbeddingSpec
): Promise<Buffer>;
export function normalizeModelRgb(
  data: Uint8Array,
  image: ImageEmbeddingSpec
): Float32Array;
