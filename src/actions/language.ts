import type { i18n } from "i18next";
import { LOCAL_STORAGE_KEYS } from "@/constants";

function detectSystemLanguage(): string {
  // navigator.language returns e.g. "zh-CN", "en-US", "ja-JP"
  const nav =
    navigator.language || (navigator as any).userLanguage || "";
  if (nav.toLowerCase().startsWith("zh")) return "zh";
  return "en";
}

export function setAppLanguage(lang: string, i18n: i18n) {
  localStorage.setItem(LOCAL_STORAGE_KEYS.LANGUAGE, lang);
  i18n.changeLanguage(lang);
  document.documentElement.lang = lang;
  // Sync language to main process so tray menu labels update
  window.electronAPI?.setLanguage?.(lang);
}

export function updateAppLanguage(i18n: i18n) {
  const saved = localStorage.getItem(LOCAL_STORAGE_KEYS.LANGUAGE);
  const lang = saved || detectSystemLanguage();
  i18n.changeLanguage(lang);
  document.documentElement.lang = lang;
  // Sync initial language to main process on app startup
  window.electronAPI?.setLanguage?.(lang);
}
