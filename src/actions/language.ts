import type { i18n } from "i18next";
import { LOCAL_STORAGE_KEYS } from "@/constants";

export function setAppLanguage(lang: string, i18n: i18n) {
  localStorage.setItem(LOCAL_STORAGE_KEYS.LANGUAGE, lang);
  i18n.changeLanguage(lang);
  document.documentElement.lang = lang;
  // Sync language to main process so tray menu labels update
  window.electronAPI?.setLanguage?.(lang);
}

export function updateAppLanguage(i18n: i18n) {
  const localLang = localStorage.getItem(LOCAL_STORAGE_KEYS.LANGUAGE);
  if (!localLang) {
    return;
  }

  i18n.changeLanguage(localLang);
  document.documentElement.lang = localLang;
  // Sync initial language to main process on app startup
  window.electronAPI?.setLanguage?.(localLang);
}
