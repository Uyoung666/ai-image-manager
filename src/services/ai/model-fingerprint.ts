import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  EmbeddingAdapterDescriptor,
  ModelArtifactSpec,
  SerializedWorkerAdapter,
} from "./model-adapter";
import { getActiveEmbeddingAdapter } from "./model-adapter";

export interface ModelFingerprintPayload {
  adapterId: string;
  artifacts: Array<{ relativePath: string; sha256: string }>;
  dimensions: number;
  embeddingAlgorithmVersion: string;
  image: {
    inputName: string;
    outputName: string;
    imageSize: number;
    resizeFit: string;
    mean: [number, number, number];
    std: [number, number, number];
  };
  modelId: string;
  normalization: "l2";
  revision: string;
  schemaVersion: 1;
  text: {
    engine: string;
    inputNames: Record<string, string>;
    modelRelativePath: string;
    outputName: string;
    maxLength: number;
    padding: string;
    tokenizerRelativePath?: string;
  };
}

export interface StoredVectorFingerprint {
  adapterId: string;
  createdAt: string;
  dimensions: number;
  fingerprint: string;
  schemaVersion: 1;
  source: "fresh-build" | "legacy-adoption";
}

export type VectorCompatibility =
  | "empty"
  | "matching"
  | "legacy-compatible"
  | "missing-fingerprint"
  | "fingerprint-mismatch"
  | "invalid-fingerprint"
  | "dimension-mismatch";

export type VectorFingerprintMarker =
  | { state: "missing" }
  | { state: "invalid" }
  | { state: "valid"; value: StoredVectorFingerprint };

export interface VectorCompatibilityIdentity {
  adapterId: string;
  dimensions: number;
  fingerprint: string;
  legacyKind?: "siglip";
}

export interface VectorCompatibilityDecision {
  adoptLegacy: boolean;
  status: VectorCompatibility;
}

export interface VectorCompatibilityDecisionInput {
  active: VectorCompatibilityIdentity;
  legacyArtifactsVerified: boolean;
  marker: VectorFingerprintMarker;
  rowCount: number;
  vectorDimensions: number;
}

export interface VectorFingerprintPublicationInput {
  hasVectorTable: boolean;
  indexReady: boolean;
  processed: number;
  runWritable: boolean;
  total: number;
}

const EMBEDDING_ALGORITHM_VERSION = "siglip-adapter-v1";
const SHA256_RE = /^[a-f0-9]{64}$/u;
const PATH_SPLIT_RE = /[\\/]/u;

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortKeys(entry)])
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function buildModelFingerprintPayload(
  adapter: EmbeddingAdapterDescriptor
): ModelFingerprintPayload {
  const image = adapter.embeddingSpace.image;
  const text = adapter.embeddingSpace.text;
  return {
    schemaVersion: 1,
    adapterId: adapter.id,
    modelId: adapter.modelId,
    revision: adapter.revision,
    artifacts: [...adapter.artifacts]
      .sort((left, right) =>
        left.relativePath.localeCompare(right.relativePath)
      )
      .map(({ relativePath, sha256 }) => ({ relativePath, sha256 })),
    dimensions: adapter.embeddingSpace.dimensions,
    image: {
      inputName: image.inputName,
      outputName: image.outputName,
      imageSize: image.imageSize,
      resizeFit: image.resizeFit,
      mean: [...image.mean] as [number, number, number],
      std: [...image.std] as [number, number, number],
    },
    text: {
      engine: text.engine,
      inputNames: { ...text.inputNames },
      modelRelativePath: text.modelRelativePath,
      outputName: text.outputName,
      maxLength: text.maxLength,
      padding: text.padding,
      tokenizerRelativePath: text.tokenizerRelativePath,
    },
    normalization: adapter.embeddingSpace.normalization,
    embeddingAlgorithmVersion: EMBEDDING_ALGORITHM_VERSION,
  };
}

export function getModelFingerprint(
  adapter: EmbeddingAdapterDescriptor
): string {
  return sha256Canonical(buildModelFingerprintPayload(adapter));
}

export function getActiveEmbeddingFingerprint(): string {
  return getModelFingerprint(getActiveEmbeddingAdapter());
}

export function getWorkerAdapterFingerprint(
  adapter: SerializedWorkerAdapter
): string {
  return adapter.fingerprint;
}

export function isValidSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_RE.test(value);
}

export function isValidStoredVectorFingerprint(
  value: unknown
): value is StoredVectorFingerprint {
  if (!value || typeof value !== "object") {
    return false;
  }
  const stored = value as Partial<StoredVectorFingerprint>;
  const dimensions = stored.dimensions;
  return (
    stored.schemaVersion === 1 &&
    isValidSha256(stored.fingerprint) &&
    typeof stored.adapterId === "string" &&
    typeof dimensions === "number" &&
    Number.isInteger(dimensions) &&
    dimensions > 0 &&
    typeof stored.createdAt === "string" &&
    (stored.source === "fresh-build" || stored.source === "legacy-adoption")
  );
}

export function decideVectorCompatibility({
  active,
  legacyArtifactsVerified,
  marker,
  rowCount,
  vectorDimensions,
}: VectorCompatibilityDecisionInput): VectorCompatibilityDecision {
  if (marker.state === "valid") {
    if (
      marker.value.dimensions !== active.dimensions ||
      vectorDimensions !== active.dimensions
    ) {
      return { status: "dimension-mismatch", adoptLegacy: false };
    }
    if (
      marker.value.adapterId !== active.adapterId ||
      marker.value.fingerprint !== active.fingerprint
    ) {
      return { status: "fingerprint-mismatch", adoptLegacy: false };
    }
    return { status: "matching", adoptLegacy: false };
  }

  if (marker.state === "invalid") {
    return { status: "invalid-fingerprint", adoptLegacy: false };
  }
  if (rowCount === 0) {
    return { status: "empty", adoptLegacy: false };
  }
  if (vectorDimensions !== active.dimensions) {
    return { status: "dimension-mismatch", adoptLegacy: false };
  }
  if (active.legacyKind === "siglip" && legacyArtifactsVerified) {
    return { status: "legacy-compatible", adoptLegacy: true };
  }
  return { status: "missing-fingerprint", adoptLegacy: false };
}

export function resolveRuntimeVectorCompatibility(
  active: VectorCompatibilityIdentity,
  runtime: VectorCompatibilityIdentity,
  storedCompatibility: VectorCompatibility
): VectorCompatibility {
  if (runtime.dimensions !== active.dimensions) {
    return "dimension-mismatch";
  }
  if (
    runtime.adapterId !== active.adapterId ||
    runtime.fingerprint !== active.fingerprint
  ) {
    return "fingerprint-mismatch";
  }
  return storedCompatibility;
}

export function isVectorCompatibilitySearchable(
  compatibility: VectorCompatibility
): boolean {
  return (
    compatibility === "empty" ||
    compatibility === "matching" ||
    compatibility === "legacy-compatible"
  );
}

export function shouldPublishVectorFingerprint({
  hasVectorTable,
  indexReady,
  processed,
  runWritable,
  total,
}: VectorFingerprintPublicationInput): boolean {
  return (
    hasVectorTable &&
    indexReady &&
    runWritable &&
    total > 0 &&
    processed === total
  );
}

export function getVectorFingerprintPath(dataPath: string): string {
  return path.join(dataPath, "vectors", ".model_fingerprint.json");
}

export function inspectStoredVectorFingerprint(
  dataPath: string
): VectorFingerprintMarker {
  const markerPath = getVectorFingerprintPath(dataPath);
  if (!fs.existsSync(markerPath)) {
    return { state: "missing" };
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
    return isValidStoredVectorFingerprint(parsed)
      ? { state: "valid", value: parsed }
      : { state: "invalid" };
  } catch {
    return { state: "invalid" };
  }
}

export function readStoredVectorFingerprint(
  dataPath: string
): StoredVectorFingerprint | null {
  const marker = inspectStoredVectorFingerprint(dataPath);
  return marker.state === "valid" ? marker.value : null;
}

export async function writeStoredVectorFingerprint(
  dataPath: string,
  fingerprint: StoredVectorFingerprint
): Promise<void> {
  if (!isValidStoredVectorFingerprint(fingerprint)) {
    throw new Error("Invalid vector fingerprint marker");
  }
  const markerPath = getVectorFingerprintPath(dataPath);
  const tempPath = `${markerPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.mkdir(path.dirname(markerPath), { recursive: true });
  await fs.promises.writeFile(
    tempPath,
    `${JSON.stringify(fingerprint, null, 2)}\n`,
    "utf-8"
  );
  await fs.promises.rename(tempPath, markerPath);
}

export async function verifyAdapterArtifacts(
  modelRoot: string,
  artifacts: ModelArtifactSpec[]
): Promise<boolean> {
  const requiredArtifacts = artifacts.filter((artifact) => artifact.required);
  for (const artifact of requiredArtifacts) {
    const filePath = path.join(
      modelRoot,
      ...artifact.relativePath.split(PATH_SPLIT_RE)
    );
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.size !== artifact.sizeBytes) {
        return false;
      }
      const hash = await hashFile(filePath);
      if (hash !== artifact.sha256) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
