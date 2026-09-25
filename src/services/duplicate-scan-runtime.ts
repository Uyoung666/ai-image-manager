const activeDuplicateScanRuns = new Set<string>();

/**
 * Process-local guard for a scan currently doing file/vector work. The
 * database row remains the cross-process audit record; this set prevents a
 * long-running scan from being mistaken for an abandoned row after a fixed
 * lease interval.
 */
export function markDuplicateScanActive(runId: string): void {
  activeDuplicateScanRuns.add(runId);
}

export function markDuplicateScanFinished(runId: string): void {
  activeDuplicateScanRuns.delete(runId);
}

export function hasActiveDuplicateScan(): boolean {
  return activeDuplicateScanRuns.size > 0;
}

export interface DuplicateScanProgress {
  processed: number;
  stage:
    | "idle"
    | "queued"
    | "hashing"
    | "matching"
    | "verifying"
    | "publishing"
    | "completed"
    | "cancelled"
    | "failed";
  total: number;
}

let generation = 0;
let tail: Promise<unknown> = Promise.resolve();
let pending: {
  key: string;
  generation: number;
  promise: Promise<unknown>;
} | null = null;
let progress: DuplicateScanProgress = { stage: "idle", processed: 0, total: 0 };

export function getDuplicateScanProgress(): DuplicateScanProgress {
  return { ...progress };
}

export function cancelDuplicateScan(): void {
  generation += 1;
  progress = { ...progress, stage: "cancelled" };
}

export interface DuplicateScanContext {
  assertCurrent: () => void;
  report: (
    stage: DuplicateScanProgress["stage"],
    processed: number,
    total: number
  ) => void;
}

/** Same requests share work; different requests supersede and serialize. */
export function runDuplicateScan<T>(
  key: string,
  task: (context: DuplicateScanContext) => Promise<T>
): Promise<T> {
  if (pending?.key === key && pending.generation === generation) {
    return pending.promise as Promise<T>;
  }
  const current = ++generation;
  const assertCurrent = () => {
    if (current !== generation) {
      throw new Error(
        "SCAN_CANCELLED: Duplicate scan was superseded or cancelled"
      );
    }
  };
  progress = { stage: "queued", processed: 0, total: 0 };
  const promise = tail
    .catch(() => undefined)
    .then(async () => {
      assertCurrent();
      try {
        const result = await task({
          assertCurrent,
          report: (stage, processed, total) => {
            assertCurrent();
            progress = { stage, processed, total };
          },
        });
        assertCurrent();
        progress = { ...progress, stage: "completed" };
        return result;
      } catch (error) {
        if (current === generation) {
          progress = { ...progress, stage: "failed" };
        }
        throw error;
      } finally {
        if (pending?.generation === current) {
          pending = null;
        }
      }
    });
  pending = { key, generation: current, promise };
  tail = promise.catch(() => undefined);
  return promise;
}
