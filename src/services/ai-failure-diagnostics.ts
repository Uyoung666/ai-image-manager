import { getActiveEmbeddingModel } from "./ai/model-config";
import {
  type DiagnosticFailureContext,
  recordDiagnosticIncident,
} from "./diagnostics/incidents";
import { appendDiagnosticLog } from "./diagnostics/logging";

/** Persist handled AI failures as well as process crashes, before a retry or restart. */
export function recordAiFailure(
  error: unknown,
  context: DiagnosticFailureContext
): void {
  try {
    let modelContext = {};
    try {
      const model = getActiveEmbeddingModel();
      modelContext = {
        adapterId: model.adapterId,
        modelId: model.modelId,
        modelRevision: model.revision,
      };
    } catch {
      // Preserve the actual failure even when model configuration is broken.
    }
    const message = error instanceof Error ? error.message : String(error);
    const stack = describeErrorChain(error);
    const incident = recordDiagnosticIncident({
      source: "ai-error",
      action: "ai-indexing",
      message,
      stack,
      context: { ...context, ...modelContext },
    });
    appendDiagnosticLog({
      incidentId: incident.id,
      action: "ai-indexing",
      level: "error",
      message: incident.message,
      stack: incident.stack,
      module: "ai-embedder",
      process: "main",
    });
  } catch {
    // Diagnostics must not replace the original error or prevent AI cleanup.
  }
}

function describeErrorChain(error: unknown): string | undefined {
  const details: string[] = [];
  let current = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current) && seen.size < 4) {
    seen.add(current);
    const code = "code" in current ? current.code : undefined;
    if (typeof code === "string" || typeof code === "number") {
      details.push(`Error code: ${code}`);
    }
    details.push(current.stack ?? current.message);
    current = current.cause;
  }
  return details.length ? details.join("\nCaused by:\n") : undefined;
}
