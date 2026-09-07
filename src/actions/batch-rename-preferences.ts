export const BATCH_RENAME_PATTERN_STORAGE_KEY = "batch-rename.last-pattern";

export const DEFAULT_BATCH_RENAME_PATTERN = "{yyyy}{mm}{dd}_{index:3}";

function getStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function normalizePattern(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? value
    : DEFAULT_BATCH_RENAME_PATTERN;
}

export function readBatchRenamePattern(): string {
  const storage = getStorage();
  if (!storage) {
    return DEFAULT_BATCH_RENAME_PATTERN;
  }

  try {
    return normalizePattern(storage.getItem(BATCH_RENAME_PATTERN_STORAGE_KEY));
  } catch {
    return DEFAULT_BATCH_RENAME_PATTERN;
  }
}

export function saveBatchRenamePattern(value: unknown): boolean {
  const storage = getStorage();
  if (!storage || typeof value !== "string" || !value.trim()) {
    return false;
  }

  try {
    storage.setItem(BATCH_RENAME_PATTERN_STORAGE_KEY, value);
    return true;
  } catch {
    return false;
  }
}
