/** Foreground requests interrupt recommendation subscribers, never shared workers. */
const subscribers = new Set<AbortController>();
let foregroundRequests = 0;
let preferenceRevision = 0;

export function invalidateStarterPreferences(): void {
  preferenceRevision++;
}

export function getStarterPreferenceRevision(): number {
  return preferenceRevision;
}

export function beginForegroundSearch(): () => void {
  foregroundRequests++;
  for (const controller of subscribers) {
    controller.abort();
  }
  let finished = false;
  return () => {
    if (!finished) {
      finished = true;
      foregroundRequests--;
    }
  };
}

export function beginBackgroundSearch() {
  const controller = new AbortController();
  if (foregroundRequests > 0) {
    controller.abort();
  }
  subscribers.add(controller);
  return {
    signal: controller.signal,
    finish: () => subscribers.delete(controller),
  };
}

export async function runForegroundSearch<T>(
  task: () => Promise<T>
): Promise<T> {
  const finish = beginForegroundSearch();
  try {
    return await task();
  } finally {
    finish();
  }
}
