import type { i18n as I18nInstance } from "i18next";
import { LOCAL_STORAGE_KEYS } from "@/constants";
import { ipc } from "@/ipc/manager";
import type { LocaleRuntimeState } from "@/localization/catalog";

function readLegacyLocale(): "zh" | "en" | undefined {
  try {
    const value = localStorage.getItem(LOCAL_STORAGE_KEYS.LANGUAGE);
    return value === "zh" || value === "en" ? value : undefined;
  } catch {
    return undefined;
  }
}

function detectBuiltinFallback(): "zh" | "en" {
  const nav =
    typeof navigator === "undefined" ? "" : navigator.language.toLowerCase();
  return nav.startsWith("zh") ? "zh" : "en";
}

function ensureIpcReady(): void {
  // IPCManager.initialize is idempotent. Calling it here makes the first
  // language request deterministic instead of racing its deferred bootstrap.
  ipc.initialize();
}

function clearDynamicBundle(i18n: I18nInstance, locale: string): void {
  if (i18n.hasResourceBundle(locale, "translation")) {
    i18n.removeResourceBundle(locale, "translation");
  }
}

function changeLanguageSafely(i18n: I18nInstance, locale: string): void {
  try {
    Promise.resolve(i18n.changeLanguage(locale)).catch(() => undefined);
  } catch {
    // A renderer-only test adapter or a partially initialized i18next instance
    // must not prevent the document language and app mount from progressing.
  }
}

function applyLocaleState(i18n: I18nInstance, state: LocaleRuntimeState): void {
  if (state.renderer) {
    clearDynamicBundle(i18n, state.selectedLocale);
    i18n.addResourceBundle(
      state.selectedLocale,
      "translation",
      state.renderer,
      true,
      true
    );
  }
  // i18next mutates its active language synchronously when resources are
  // already present. Do not await the returned promise: legacy test/runtime
  // adapters may intentionally expose a never-settling promise here.
  changeLanguageSafely(i18n, state.selectedLocale);
  document.documentElement.lang = state.selectedLocale;
  document.documentElement.dir = state.direction;
  try {
    localStorage.setItem(LOCAL_STORAGE_KEYS.LANGUAGE, state.selectedLocale);
  } catch {
    // localStorage is optional; the main-process preference remains canonical.
  }
}

function applyBuiltinFallback(i18n: I18nInstance): void {
  const saved = readLegacyLocale();
  const nav =
    typeof navigator === "undefined" ? "" : navigator.language.toLowerCase();
  const locale = saved ?? (nav.startsWith("zh") ? "zh" : "en");
  changeLanguageSafely(i18n, locale);
  document.documentElement.lang = locale;
  document.documentElement.dir = "ltr";
}

/** Load the canonical main-process selection before React mounts. */
export async function initializeAppLanguage(
  i18n: I18nInstance
): Promise<LocaleRuntimeState | null> {
  try {
    ensureIpcReady();
    const state = await ipc.client.localization.initialize({
      legacyLocale: readLegacyLocale(),
    });
    applyLocaleState(i18n, state);
    return state;
  } catch {
    applyBuiltinFallback(i18n);
    return null;
  }
}

/** Backwards-compatible alias used by older renderer callers. */
export function updateAppLanguage(
  i18n: I18nInstance
): Promise<LocaleRuntimeState | null> {
  return initializeAppLanguage(i18n);
}

export async function setAppLocale(
  locale: string,
  i18n: I18nInstance,
  providerPluginId?: string | null
): Promise<LocaleRuntimeState | null> {
  try {
    ensureIpcReady();
    const state = await ipc.client.localization.select({
      locale,
      providerPluginId,
    });
    applyLocaleState(i18n, state);
    return state;
  } catch (error) {
    // Keep the old built-in toggle useful when the main process is unavailable
    // during hot reload or a renderer-only test.
    if (locale === "zh" || locale === "en") {
      changeLanguageSafely(i18n, locale);
      document.documentElement.lang = locale;
      document.documentElement.dir = "ltr";
      try {
        localStorage.setItem(LOCAL_STORAGE_KEYS.LANGUAGE, locale);
      } catch {
        // optional
      }
      return null;
    }
    throw error;
  }
}

export function setAppLanguage(
  lang: string,
  i18n: I18nInstance
): Promise<LocaleRuntimeState | null> {
  return setAppLocale(
    lang === "zh" || lang === "en" ? lang : detectBuiltinFallback(),
    i18n
  );
}

export function getAvailableLocales() {
  ensureIpcReady();
  return ipc.client.localization.listOptions({});
}

/** Reconcile the active plugin locale after an install, reload, or uninstall. */
export async function revalidateAppLocale(
  i18n: I18nInstance
): Promise<LocaleRuntimeState | null> {
  try {
    ensureIpcReady();
    const state = await ipc.client.localization.revalidate({});
    applyLocaleState(i18n, state);
    return state;
  } catch {
    applyBuiltinFallback(i18n);
    return null;
  }
}

export async function previewAppLocale(
  locale: string,
  i18n: I18nInstance,
  providerPluginId?: string | null
): Promise<LocaleRuntimeState> {
  ensureIpcReady();
  const state = await ipc.client.localization.preview({
    locale,
    providerPluginId,
  });
  applyLocaleState(i18n, state);
  return state;
}

export async function restoreAppLocalePreview(
  i18n: I18nInstance
): Promise<LocaleRuntimeState> {
  ensureIpcReady();
  const state = await ipc.client.localization.restorePreview({});
  applyLocaleState(i18n, state);
  return state;
}
