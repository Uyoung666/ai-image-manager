import path from "node:path";
import { sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import { photos } from "@/db/schema";
import { getDataPath } from "@/utils/data-path";
import { MIN_VECTORS_FOR_INDEX } from "./constants";
import { type AiCoverageState, deriveAiCoverageState } from "./coverage";
import { getActiveEmbeddingRuntimeInfo } from "./model-config";
import {
  isVectorCompatibilitySearchable,
  resolveRuntimeVectorCompatibility,
  type VectorCompatibility,
} from "./model-fingerprint";
import { loadModel } from "./model-loader";
import {
  currentProgress,
  embeddingModel,
  getActiveEmbeddingRuntime,
  isEmbedding,
  isModelLoaded,
  photoTable,
  setPhotoTable,
  setVectordb,
  vectordb,
} from "./state";
import {
  getTranslationState,
  type TranslationState,
} from "./translation-worker-client";
import { initVectorDB } from "./vector-db";

export interface AiHealthStatus {
  embeddingAdapterId?: string;
  embeddingFingerprint?: string;
  lancedb: "ok" | "error";
  lancedbDetail: string;
  overall: "healthy" | "degraded" | "unhealthy";
  textModel: "ok" | "not_loaded" | "error";
  thresholdCalibrationStatus?: string;
  thresholdProfileId?: string;
  translationState: TranslationState;
  vectorCompatibility?: VectorCompatibility;
  vectorIndex: "ok" | "missing" | "error";
  vectorTable: "ok" | "missing" | "error";
  vectorTableRows: number;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getListSize(type: unknown): number | undefined {
  if (
    typeof type === "object" &&
    type !== null &&
    "listSize" in type &&
    typeof type.listSize === "number"
  ) {
    return type.listSize;
  }
  return undefined;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: health probing keeps database, model, and readiness checks together.
export async function checkAiHealth(): Promise<AiHealthStatus> {
  const runtime = getActiveEmbeddingRuntime();
  const status: AiHealthStatus = {
    lancedb: "error",
    lancedbDetail: "",
    vectorTable: "error",
    vectorTableRows: 0,
    vectorIndex: "error",
    textModel: "not_loaded",
    translationState: getTranslationState(),
    overall: "unhealthy",
  };
  if (runtime) {
    const active = getActiveEmbeddingRuntimeInfo();
    status.embeddingAdapterId = active.adapterId;
    status.embeddingFingerprint = active.fingerprint;
    status.vectorCompatibility = resolveRuntimeVectorCompatibility(
      active,
      runtime,
      runtime.vectorCompatibility
    );
    status.thresholdProfileId = runtime.thresholdProfileId;
    status.thresholdCalibrationStatus = runtime.calibrationStatus;
  }

  try {
    if (!vectordb) {
      const vectorPath = path.join(getDataPath(), "vectors");
      const lancedb = await import("@lancedb/lancedb");
      setVectordb(await lancedb.connect(vectorPath));
    }

    const connection = vectordb;
    if (!connection) {
      throw new Error("Vector database connection is unavailable");
    }
    const tableNames = await connection.tableNames();
    status.lancedb = "ok";
    status.lancedbDetail = `connected, tables: ${tableNames.join(", ") || "(none)"}`;

    if (tableNames.includes("photo_embeddings")) {
      if (!photoTable) {
        setPhotoTable(await connection.openTable("photo_embeddings"));
      }

      const table = photoTable;
      if (!table) {
        throw new Error("Photo embedding table is unavailable");
      }
      const rowCount = await table.countRows();
      status.vectorTable = "ok";
      status.vectorTableRows = rowCount;

      // Verify schema: vector column must be FixedSizeList
      try {
        const schema = await table.schema();
        const vectorField = schema.fields.find(
          (field) => field.name === "vector"
        );
        const listSize = getListSize(vectorField?.type);
        if (listSize !== undefined && listSize > 0) {
          status.lancedbDetail += `, schema: FixedSizeList<${listSize}>`;
        } else {
          status.lancedbDetail +=
            ", schema: WARNING — vector column not FixedSizeList";
        }
      } catch {
        status.lancedbDetail += ", schema: could not read";
      }

      try {
        const indices = await table.listIndices();
        const hasIndex = indices.some(
          (idx) => idx.columns.includes("vector") || idx.name === "vector_idx"
        );
        status.vectorIndex = hasIndex ? "ok" : "missing";
      } catch {
        status.vectorIndex = "error";
      }
    } else {
      status.vectorTable = "missing";
      status.vectorIndex = "missing";
    }
  } catch (err: unknown) {
    status.lancedb = "error";
    status.lancedbDetail = getErrorMessage(err);
    status.vectorTable = "error";
    status.vectorIndex = "error";
  }

  // 2. Check text model
  if (isModelLoaded && embeddingModel) {
    status.textModel = "ok";
  } else {
    try {
      await loadModel();
      status.textModel = "ok";
    } catch {
      status.textModel = "error";
    }
  }

  // 3. Determine overall health
  if (
    status.lancedb === "ok" &&
    status.vectorTable === "ok" &&
    status.vectorTableRows > 1 &&
    (status.vectorIndex === "ok" ||
      status.vectorTableRows < MIN_VECTORS_FOR_INDEX) &&
    status.textModel === "ok" &&
    (!status.vectorCompatibility ||
      isVectorCompatibilitySearchable(status.vectorCompatibility))
  ) {
    status.overall = "healthy";
  } else if (
    status.lancedb === "ok" &&
    status.vectorTable === "ok" &&
    status.vectorTableRows > 0 &&
    status.textModel === "ok"
  ) {
    status.overall = "degraded";
  } else {
    status.overall = "unhealthy";
  }

  console.log(
    `[AI] Health check: ${status.overall} (lancedb=${status.lancedb}, table=${status.vectorTable}(${status.vectorTableRows} rows), index=${status.vectorIndex}, model=${status.textModel})`
  );

  return status;
}

export interface AiReadiness {
  coverageState: AiCoverageState;
  embeddingProgress: {
    loadingStartedAt?: number | null;
    phase: string;
    processed: number;
    total: number;
  };
  hasVectors: boolean;
  indexedPhotos: number;
  indexReady: boolean;
  isEmbedding: boolean;
  lastError?: string;
  model: "loading" | "ready" | "error";
  pendingPhotos: number;
  totalPhotos: number;
  translationState: TranslationState;
  vectorCount: number;
  vectorDB: "loading" | "ready" | "error";
}

export async function getAiReadiness(options?: {
  loadModel?: boolean;
}): Promise<AiReadiness> {
  const readiness: AiReadiness = {
    model: isModelLoaded ? "ready" : "loading",
    vectorDB: "loading",
    hasVectors: false,
    coverageState: "unavailable",
    vectorCount: 0,
    indexReady: false,
    indexedPhotos: 0,
    pendingPhotos: 0,
    totalPhotos: 0,
    translationState: getTranslationState(),
    isEmbedding,
    lastError:
      currentProgress.phase === "error" ? currentProgress.error : undefined,
    embeddingProgress: {
      processed: currentProgress.processed,
      total: currentProgress.total,
      phase: currentProgress.phase,
      loadingStartedAt: currentProgress.loadingStartedAt ?? null,
    },
  };
  readiness.totalPhotos =
    getDatabase()
      .select({ count: sql<number>`count(*)` })
      .from(photos)
      .where(sql`${photos.deletedAt} IS NULL`)
      .get()?.count ?? 0;
  readiness.pendingPhotos = readiness.totalPhotos;

  if (!isModelLoaded && options?.loadModel !== false) {
    try {
      await loadModel();
      readiness.model = "ready";
    } catch {
      readiness.model = "error";
    }
  }

  try {
    await initVectorDB();
    const table = photoTable;
    if (table) {
      readiness.vectorDB = "ready";
      const rowCount = await table.countRows();
      // Cap at non-deleted photo count to exclude orphan vectors from trashed photos
      const nonDeletedCount = readiness.totalPhotos;
      readiness.vectorCount = Math.min(rowCount, nonDeletedCount);
      readiness.totalPhotos = nonDeletedCount;
      readiness.indexedPhotos = readiness.vectorCount;
      readiness.pendingPhotos = Math.max(
        0,
        readiness.totalPhotos - readiness.indexedPhotos
      );
      readiness.hasVectors = readiness.vectorCount > 0;

      if (rowCount >= MIN_VECTORS_FOR_INDEX) {
        const indices = await table.listIndices();
        readiness.indexReady = indices.some(
          (idx) => idx.columns.includes("vector") || idx.name === "vector_idx"
        );
      } else if (rowCount > 0) {
        // Below threshold — brute-force search works, mark index as "ready enough"
        readiness.indexReady = true;
      }
    }
  } catch {
    readiness.vectorDB = "error";
  }

  readiness.coverageState = deriveAiCoverageState(
    readiness.totalPhotos,
    readiness.indexedPhotos,
    Boolean(
      readiness.lastError ||
        readiness.model === "error" ||
        readiness.vectorDB === "error"
    )
  );
  readiness.translationState = getTranslationState();

  return readiness;
}
