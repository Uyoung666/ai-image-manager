import { AsyncLocalStorage } from "node:async_hooks";

export interface SearchQualityTraceEvent {
  data: unknown;
  requestId: string;
  stage: string;
}

interface TraceContext {
  observer: (event: SearchQualityTraceEvent) => void;
  requestId: string;
}

const traces = new AsyncLocalStorage<TraceContext>();

/** Internal diagnostics only: no IPC exposure, persistence or default observer. */
export function withSearchQualityTrace<T>(
  requestId: string,
  observer: TraceContext["observer"],
  task: () => T
): T {
  return traces.run({ observer, requestId }, task);
}

/** Lazy payloads avoid copying vectors/results when tracing is disabled. */
export function traceSearchQuality(stage: string, data: () => unknown): void {
  const context = traces.getStore();
  if (!context) {
    return;
  }
  try {
    context.observer({ requestId: context.requestId, stage, data: data() });
  } catch {
    // A diagnostic observer cannot change search results or error handling.
  }
}
