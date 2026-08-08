import { ipc } from "@/ipc/manager";

export const UI_REDUCE_MOTION_KEY = "ui.reduceMotion";
export const UI_REDUCE_MOTION_STORAGE_KEY = UI_REDUCE_MOTION_KEY;

export function parseReduceMotionValue(value: string | null | undefined) {
  return value === "true";
}

export function readCachedReduceMotion() {
  try {
    return parseReduceMotionValue(
      window.localStorage.getItem(UI_REDUCE_MOTION_STORAGE_KEY)
    );
  } catch {
    return false;
  }
}

export function cacheReduceMotion(value: boolean) {
  try {
    window.localStorage.setItem(UI_REDUCE_MOTION_STORAGE_KEY, String(value));
  } catch {
    // localStorage is best-effort; SQLite remains the source of persistence.
  }
}

export async function getReduceMotionPreference() {
  const result = await ipc.client.settings.getAppSetting({
    key: UI_REDUCE_MOTION_KEY,
  });
  const value = parseReduceMotionValue(
    result && typeof result === "object" && "value" in result
      ? (result as { value?: string | null }).value
      : undefined
  );
  cacheReduceMotion(value);
  return value;
}

export async function setReduceMotionPreference(value: boolean) {
  await ipc.client.settings.setAppPreference({
    key: UI_REDUCE_MOTION_KEY,
    value: String(value),
  });
  cacheReduceMotion(value);
}

/** The document attribute is the non-React source used before the first render. */
export function isReducedMotionEnabled() {
  return (
    typeof document !== "undefined" &&
    document.documentElement.dataset.reducedMotion === "true"
  );
}
