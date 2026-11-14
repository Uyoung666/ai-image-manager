import { setTimeout as delay } from "node:timers/promises";
import { registerGalleryCleanup } from "@/utils/gallery-lifecycle";

const FOREGROUND_LEASE_MS = 300;
const IDLE_CHECK_INTERVAL_MS = 50;
let busyUntil = 0;
let generation = 0;

/** Give active browsing a short foreground window without retaining user state. */
export function noteLibraryForegroundActivity(): void {
  busyUntil = performance.now() + FOREGROUND_LEASE_MS;
}

export function isLibraryForegroundBusy(): boolean {
  return performance.now() < busyUntil;
}

/** Background work yields briefly; explicit user actions do not use this gate. */
export async function waitForLibraryForegroundIdle(
  isCurrent: () => boolean,
  signal?: AbortSignal
): Promise<boolean> {
  const expectedGeneration = generation;
  const current = () =>
    expectedGeneration === generation && !signal?.aborted && isCurrent();
  while (current()) {
    const remaining = busyUntil - performance.now();
    if (remaining <= 0) {
      return true;
    }
    try {
      await delay(Math.min(IDLE_CHECK_INTERVAL_MS, remaining), undefined, {
        ref: false,
        signal,
      });
    } catch (error) {
      if (signal?.aborted) {
        return false;
      }
      throw error;
    }
  }
  return false;
}

registerGalleryCleanup(() => {
  generation++;
  busyUntil = 0;
});
