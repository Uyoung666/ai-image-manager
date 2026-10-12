import { createHash } from "node:crypto";
import fs from "node:fs";

export function verifyBenchmarkVectors(samples, rows, dimensions) {
  const byId = new Map();
  for (const row of rows) {
    if (byId.has(row.id)) {
      throw new Error(`Duplicate cached photo ID: ${row.id}`);
    }
    byId.set(row.id, row);
  }
  let maximumNormError = 0;
  for (const sample of samples) {
    const digest = createHash("sha256")
      .update(fs.readFileSync(sample.filePath))
      .digest("hex");
    const row = byId.get(sample.index + 1);
    if (digest !== sample.source.sha256 || row?.sha256 !== digest) {
      throw new Error(`Image/vector content mismatch: ${sample.id}`);
    }
    if (
      row.vector.length !== dimensions ||
      !row.vector.every(Number.isFinite)
    ) {
      throw new Error(`Invalid vector dimensions or values: ${sample.id}`);
    }
    const normError = Math.abs(Math.hypot(...row.vector) - 1);
    if (normError > 0.0001) {
      throw new Error(`Unnormalized vector: ${sample.id}`);
    }
    maximumNormError = Math.max(maximumNormError, normError);
  }
  return {
    verifiedImages: samples.length,
    dimensions,
    maximumNormError,
    mapping: "manifest index + 1; content SHA-256 verified",
  };
}
