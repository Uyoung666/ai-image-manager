import { ipc } from "@/ipc/manager";
import {
  ACCENT_COLOR_KEY,
  type AccentColor,
  type AccentTheme,
  DEFAULT_ACCENT_COLOR,
  parseAccentColor,
} from "@/types/accent-color";

export const ACCENT_COLOR_STORAGE_KEY = ACCENT_COLOR_KEY;

export function getCurrentAccentTheme(): AccentTheme {
  if (typeof document !== "undefined") {
    return document.documentElement.classList.contains("light")
      ? "light"
      : "dark";
  }
  return "dark";
}

export function readCachedAccentColor(): AccentColor {
  try {
    return parseAccentColor(
      window.localStorage.getItem(ACCENT_COLOR_STORAGE_KEY),
      getCurrentAccentTheme()
    );
  } catch {
    return DEFAULT_ACCENT_COLOR;
  }
}

export function cacheAccentColor(value: AccentColor) {
  try {
    window.localStorage.setItem(ACCENT_COLOR_STORAGE_KEY, value);
  } catch {
    // localStorage is best-effort; SQLite remains the source of persistence.
  }
}

function persistAccentColor(value: AccentColor) {
  return ipc.client.settings.setAppPreference({
    key: ACCENT_COLOR_KEY,
    value,
  });
}

export function applyAccentColor(value: string | null | undefined) {
  const parsed = parseAccentColor(value, getCurrentAccentTheme());
  if (typeof document !== "undefined") {
    document.documentElement.dataset.accentColor = parsed;
  }
  return parsed;
}

export async function getAccentColorPreference() {
  const preferences = await ipc.client.settings.getAppPreferences({});
  const value = applyAccentColor(preferences.accentColor);
  cacheAccentColor(value);
  if (value !== preferences.accentColor) {
    await persistAccentColor(value).catch(() => undefined);
  }
  return value;
}

export async function setAccentColorPreference(value: AccentColor) {
  const parsed = parseAccentColor(value, getCurrentAccentTheme());
  await persistAccentColor(parsed);
  if (typeof document !== "undefined") {
    document.documentElement.dataset.accentColor = parsed;
  }
  cacheAccentColor(parsed);
  return parsed;
}
