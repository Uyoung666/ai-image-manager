import type { i18n as I18nInstance } from "i18next";
import {
  initializeAppLanguage as initialize,
  setAppLanguage as setLanguage,
  setAppLocale as setLocale,
  updateAppLanguage as update,
} from "./localization";

/** Compatibility entrypoint for existing renderer callers. */
export function initializeAppLanguage(i18n: I18nInstance) {
  return initialize(i18n);
}

export function setAppLanguage(lang: string, i18n: I18nInstance) {
  return setLanguage(lang, i18n);
}

export function setAppLocale(
  locale: string,
  i18n: I18nInstance,
  providerPluginId?: string | null
) {
  return setLocale(locale, i18n, providerPluginId);
}

export function updateAppLanguage(i18n: I18nInstance) {
  return update(i18n);
}
