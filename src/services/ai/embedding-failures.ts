export interface EmbeddingFailureSummary {
  decodeFailed: number;
  failed: number;
  inferenceFailed: number;
  modelFailed: number;
}

export function summarizeEmbeddingFailures(
  results: Iterable<{ error?: string; stage?: string }>
): EmbeddingFailureSummary {
  const summary = {
    failed: 0,
    decodeFailed: 0,
    modelFailed: 0,
    inferenceFailed: 0,
  };
  for (const result of results) {
    if (!result.error) {
      continue;
    }
    summary.failed++;
    if (result.stage === "decode") {
      summary.decodeFailed++;
    } else if (result.stage === "model") {
      summary.modelFailed++;
    } else {
      summary.inferenceFailed++;
    }
  }
  return summary;
}
