export interface OptimisticSaveQueueOptions<T> {
  initialValue: T;
  isEqual?: (left: T, right: T) => boolean;
  onCommit?: (value: T) => void;
  onRollback: (value: T) => void;
  onSaveError: () => void;
  persist: (value: T) => PromiseLike<unknown> | unknown;
}

export interface OptimisticSaveQueue<T> {
  enqueue: (value: T) => void;
  hydrate: (value: T) => boolean;
}

export function createOptimisticSaveQueue<T>(
  options: OptimisticSaveQueueOptions<T>
): OptimisticSaveQueue<T> {
  const isEqual = options.isEqual ?? Object.is;
  let committedValue = options.initialValue;
  let desiredValue = options.initialValue;
  let hasPendingValue = false;
  let pendingValue: T;
  let hydrated = false;
  let draining = false;

  async function drain() {
    if (draining) {
      return;
    }
    draining = true;
    let lastAttemptFailed = false;

    while (hasPendingValue) {
      const value = pendingValue as T;
      hasPendingValue = false;
      let saved = false;
      try {
        await options.persist(value);
        saved = true;
      } catch {
        lastAttemptFailed = true;
      }
      if (saved) {
        lastAttemptFailed = false;
        committedValue = value;
        options.onCommit?.(value);
      }
    }

    draining = false;
    if (lastAttemptFailed) {
      if (!isEqual(committedValue, desiredValue)) {
        options.onRollback(committedValue);
      }
      options.onSaveError();
    }
  }

  return {
    enqueue(value) {
      desiredValue = value;
      pendingValue = value;
      hasPendingValue = true;
      if (hydrated) {
        drain().catch(() => undefined);
      }
    },
    hydrate(value) {
      if (hydrated) {
        return false;
      }
      hydrated = true;
      committedValue = value;
      if (!hasPendingValue) {
        desiredValue = value;
        return true;
      }
      drain().catch(() => undefined);
      return false;
    },
  };
}
