import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type {
  SearchDiagnostics,
  SearchIncompleteReason,
  SearchPhase,
} from "@/types/search-diagnostics";

export class SearchInterrupted extends Error {
  readonly reason: SearchIncompleteReason;
  constructor(reason: SearchIncompleteReason) {
    super(`Search interrupted: ${reason}`);
    this.reason = reason;
  }
}

export interface SearchExecution {
  deadline: number;
  diagnostics?: SearchDiagnostics;
  finished?: boolean;
  signal?: AbortSignal;
}

export function checkSearch(execution?: SearchExecution): void {
  if (execution?.signal?.aborted) {
    throw new SearchInterrupted("cancelled");
  }
  if (execution && performance.now() >= execution.deadline) {
    throw new SearchInterrupted("deadline");
  }
}

/** Only the subscriber stops waiting; shared translation/encoding remains alive. */
export function waitForSearch<T>(
  task: Promise<T>,
  execution?: SearchExecution
): Promise<T> {
  try {
    checkSearch(execution);
  } catch (error) {
    // The task may already be running; observe its rejection after detaching.
    task.catch(() => undefined);
    return Promise.reject(error);
  }
  if (!execution) {
    return task;
  }
  return new Promise<T>((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      execution.signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      finish();
      reject(new SearchInterrupted("cancelled"));
    };
    const timer = setTimeout(
      () => {
        finish();
        reject(new SearchInterrupted("deadline"));
      },
      Math.max(0, execution.deadline - performance.now())
    );
    execution.signal?.addEventListener("abort", abort, { once: true });
    task.then(
      (value) => {
        finish();
        resolve(value);
      },
      (error) => {
        finish();
        reject(error);
      }
    );
  });
}

export async function measureSearch<T>(
  execution: SearchExecution | undefined,
  phase: SearchPhase,
  task: () => Promise<T> | T
): Promise<T> {
  const started = performance.now();
  try {
    return await task();
  } finally {
    recordSearchDuration(execution, phase, started);
  }
}

export function recordSearchDuration(
  execution: SearchExecution | undefined,
  phase: SearchPhase,
  started: number
): void {
  if (execution?.diagnostics && !execution.finished) {
    execution.diagnostics.timings[phase] =
      (execution.diagnostics.timings[phase] ?? 0) + performance.now() - started;
  }
}

export function createSearchDiagnostics(
  requestId: string = randomUUID(),
  cold = false
): SearchDiagnostics {
  return {
    requestId,
    cold,
    cacheHit: false,
    timings: {
      preparationMs: null,
      queueMs: null,
      translationMs: null,
      textEncodingMs: null,
      vectorMs: null,
      sqliteMs: null,
      rankingMs: null,
      hydrationMs: null,
      serviceMs: null,
      ipcMs: null,
      firstPaintMs: null,
    },
  };
}

const requests = new Map<number, Map<string, AbortController>>();

export function beginSearchRequest(
  owner: number,
  requestId: string
): { signal: AbortSignal; finish: () => void } {
  let owned = requests.get(owner);
  if (!owned) {
    owned = new Map();
    requests.set(owner, owned);
  }
  owned.get(requestId)?.abort();
  const controller = new AbortController();
  owned.set(requestId, controller);
  return {
    signal: controller.signal,
    finish: () => {
      if (owned.get(requestId) === controller) {
        owned.delete(requestId);
      }
      if (owned.size === 0) {
        requests.delete(owner);
      }
    },
  };
}

export function cancelSearchRequest(owner: number, requestId: string): boolean {
  const controller = requests.get(owner)?.get(requestId);
  controller?.abort();
  return Boolean(controller);
}
