import type { i18n } from "i18next";
import { LOCAL_STORAGE_KEYS } from "@/constants";

interface LegacyNavigator extends Navigator {
  userLanguage?: string;
}

function detectSystemLanguage(): string {
  // navigator.language returns e.g. "zh-CN", "en-US", "ja-JP"
  const legacyNavigator = navigator as LegacyNavigator;
  const nav = navigator.language || legacyNavigator.userLanguage || "";
  if (nav.toLowerCase().startsWith("zh")) {
    return "zh";
  }
  return "en";
}

function isSupportedLanguage(value: string | null): value is "zh" | "en" {
  return value === "zh" || value === "en";
}

export function setAppLanguage(lang: string, i18n: i18n) {
  const nextLanguage = isSupportedLanguage(lang)
    ? lang
    : detectSystemLanguage();
  localStorage.setItem(LOCAL_STORAGE_KEYS.LANGUAGE, nextLanguage);
  i18n.changeLanguage(nextLanguage);
  document.documentElement.lang = nextLanguage;
  // Sync language to main process so tray menu labels update
  window.electronAPI?.setLanguage?.(nextLanguage);
}

export function updateAppLanguage(i18n: i18n) {
  const saved = localStorage.getItem(LOCAL_STORAGE_KEYS.LANGUAGE);
  const lang = isSupportedLanguage(saved) ? saved : detectSystemLanguage();
  i18n.changeLanguage(lang);
  document.documentElement.lang = lang;
  // Sync initial language to main process on app startup
  window.electronAPI?.setLanguage?.(lang);
}
