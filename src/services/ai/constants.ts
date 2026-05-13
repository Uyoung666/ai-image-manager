// Shared constants and utility functions for AI sub-modules.

// Minimum vectors required before creating an IVF_PQ index.
// LanceDB IVF_PQ needs enough data for meaningful partitions; below this
// threshold brute-force flat search is both faster and more accurate.
export const MIN_VECTORS_FOR_INDEX = 256;

export const BATCH_SIZE = 20; // Photos per worker process
export const WORKER_TIMEOUT = 300_000; // 5 minutes per batch

export function disposeTensors(output: Record<string, any>): void {
  for (const value of Object.values(output)) {
    if (
      value &&
      typeof value === "object" &&
      typeof value.dispose === "function"
    ) {
      try {
        value.dispose();
      } catch {
        /* best-effort */
      }
    }
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = +a[i];
    const bi = +b[i];
    if (Number.isNaN(ai) || Number.isNaN(bi)) return 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}
