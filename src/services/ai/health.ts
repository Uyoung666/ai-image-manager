import path from "node:path";
import { app } from "electron";
import { MIN_VECTORS_FOR_INDEX } from "./constants";
import { loadModel } from "./model-loader";
import {
  currentProgress,
  embeddingModel,
  isEmbedding,
  isModelLoaded,
  photoTable,
  setPhotoTable,
  setVectordb,
  vectordb,
} from "./state";
import { initVectorDB } from "./vector-db";

export interface AiHealthStatus {
  lancedb: "ok" | "error";
  lancedbDetail: string;
  overall: "healthy" | "degraded" | "unhealthy";
  textModel: "ok" | "not_loaded" | "error";
  vectorIndex: "ok" | "missing" | "error";
  vectorTable: "ok" | "missing" | "error";
  vectorTableRows: number;
}

export async function checkAiHealth(): Promise<AiHealthStatus> {
  const status: AiHealthStatus = {
    lancedb: "error",
    lancedbDetail: "",
    vectorTable: "error",
    vectorTableRows: 0,
    vectorIndex: "error",
    textModel: "not_loaded",
    overall: "unhealthy",
  };

  // 1. Check LanceDB connection + table
  try {
    if (!vectordb) {
      const userDataPath = app.getPath("userData");
      const vectorPath = path.join(userDataPath, "vectors");
      const lancedb = await import("@lancedb/lancedb");
      setVectordb(await lancedb.connect(vectorPath));
    }

    const tableNames = await vectordb.tableNames();
    status.lancedb = "ok";
    status.lancedbDetail = `connected, tables: ${tableNames.join(", ") || "(none)"}`;

    if (tableNames.includes("photo_embeddings")) {
      if (!photoTable) {
        setPhotoTable(await vectordb.openTable("photo_embeddings"));
      }

      const rowCount = await photoTable.countRows();
      status.vectorTable = "ok";
      status.vectorTableRows = rowCount;

      // Verify schema: vector column must be FixedSizeList
      try {
        const schema = await photoTable.schema();
        const vectorField = schema.fields.find((f: any) => f.name === "vector");
        if (
          vectorField &&
          typeof vectorField.type === "object" &&
          (vectorField.type as any).listSize > 0
        ) {
          status.lancedbDetail += `, schema: FixedSizeList<${(vectorField.type as any).listSize}>`;
        } else {
          status.lancedbDetail +=
            ", schema: WARNING — vector column not FixedSizeList";
        }
      } catch {
        status.lancedbDetail += ", schema: could not read";
      }

      // Check index
      try {
        const indices = await photoTable.listIndices();
        const hasIndex = indices.some(
          (idx: any) => idx.column === "vector" || idx.name === "vector_idx"
        );
        status.vectorIndex = hasIndex ? "ok" : "missing";
      } catch {
        status.vectorIndex = "error";
      }
    } else {
      status.vectorTable = "missing";
      status.vectorIndex = "missing";
    }
  } catch (err: any) {
    status.lancedb = "error";
    status.lancedbDetail = err?.message || "unknown error";
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
    status.textModel === "ok"
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

// --- AI Readiness ---

export interface AiReadiness {
  embeddingProgress: { processed: number; total: number; phase: string };
  hasVectors: boolean;
  indexReady: boolean;
  isEmbedding: boolean;
  model: "loading" | "ready" | "error";
  vectorCount: number;
  vectorDB: "loading" | "ready" | "error";
}

export async function getAiReadiness(): Promise<AiReadiness> {
  const readiness: AiReadiness = {
    model: isModelLoaded ? "ready" : "loading",
    vectorDB: "loading",
    hasVectors: false,
    vectorCount: 0,
    indexReady: false,
    isEmbedding,
    embeddingProgress: {
      processed: currentProgress.processed,
      total: currentProgress.total,
      phase: currentProgress.phase,
    },
  };

  // Check model
  if (!isModelLoaded) {
    try {
      await loadModel();
      readiness.model = "ready";
    } catch {
      readiness.model = "error";
    }
  }

  // Check vector DB
  try {
    await initVectorDB();
    if (photoTable) {
      readiness.vectorDB = "ready";
      const rowCount = await photoTable.countRows();
      readiness.vectorCount = rowCount;
      readiness.hasVectors = rowCount > 0;

      if (rowCount >= MIN_VECTORS_FOR_INDEX) {
        const indices = await photoTable.listIndices();
        readiness.indexReady = indices.some(
          (idx: any) => idx.column === "vector" || idx.name === "vector_idx"
        );
      } else if (rowCount > 0) {
        // Below threshold — brute-force search works, mark index as "ready enough"
        readiness.indexReady = true;
      }
    }
  } catch {
    readiness.vectorDB = "error";
  }

  return readiness;
}
