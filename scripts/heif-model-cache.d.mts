import type { ImageEmbeddingSpec } from "../src/services/ai/model-adapter";
export const HEIF_MODEL_CACHE_PATTERN: RegExp;
export function heifSourcePrefix(input: string): string;
export function invalidateHeifModelCache(dir: string): Promise<void>;
export interface HeifCacheDescriptor {
  dir: string;
  file: string;
  generation: string;
  identity: string;
  image: ImageEmbeddingSpec;
  input: string;
}
export function describeHeifModelCache(
  input: string | Buffer,
  image: ImageEmbeddingSpec,
  dir?: string
): Promise<HeifCacheDescriptor | null>;
export function readHeifModelCache(
  descriptor: HeifCacheDescriptor | null
): Promise<Buffer | null>;
export function writeHeifModelCache(
  descriptor: HeifCacheDescriptor | null,
  png?: Buffer
): Promise<void>;
