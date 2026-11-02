import type { ImageEmbeddingSpec } from "../src/services/ai/model-adapter";
export const MAX_HEIF_PIXELS: number;
export interface HeifDecodeOptions {
  image?: ImageEmbeddingSpec;
  output?: "png" | "pixels" | "import" | "embedding";
  thumbnailSize?: number;
}
export interface HeifDecodeResult {
  buffer: Buffer;
  channels: 4;
  height: number;
  modelPng?: Buffer;
  modelRgb?: Buffer;
  orientationApplied: true;
  originalHeight: number;
  originalWidth: number;
  timings: Record<string, number>;
  width: number;
}
export function isHeifHeader(bytes: Buffer): boolean;
export function isHeifInput(input: string | Buffer): Promise<boolean>;
export function decodeHeif(
  input: string | Buffer,
  options?: HeifDecodeOptions
): Promise<HeifDecodeResult>;
