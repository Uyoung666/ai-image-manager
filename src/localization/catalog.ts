/**
 * The data contract shared by the main and renderer localization runtimes.
 *
 * Renderer catalogs intentionally stay JSON-shaped.  A plugin never supplies
 * executable code or a filesystem path; the plugin manager is responsible for
 * validating and loading the package before this contract is reached.
 */

export type LocaleDirection = "ltr";

/** JSON values accepted by a declarative locale resource. */
export type LocaleCatalogValue =
  | string
  | LocaleCatalogObject
  | LocaleCatalogValue[];

export interface LocaleCatalogObject {
  [key: string]: LocaleCatalogValue;
}

export interface MainLocaleCatalog {
  closeWindowQuestion?: string;
  closeWindowTitle?: string;
  launchAtStartup?: string;
  minimizeToTray?: string;
  quit?: string;
  showWindow?: string;
  tooltip?: string;
  [key: string]: string | undefined;
}

export interface LocaleBundle {
  direction: LocaleDirection;
  locale: string;
  main: MainLocaleCatalog;
  nativeName: string;
  providerPluginId: string;
  renderer: LocaleCatalogObject;
  version?: string;
}

export interface LocaleProviderSummary {
  direction: LocaleDirection;
  locale: string;
  nativeName: string;
  pluginId: string;
  version?: string;
}

export interface LocaleOption extends LocaleProviderSummary {
  builtIn: boolean;
}

export interface LocaleRuntimeState {
  available: LocaleOption[];
  direction: LocaleDirection;
  providerPluginId: string | null;
  renderer: LocaleCatalogObject | null;
  selectedLocale: string;
}

export const LOCALE_SETTINGS_KEYS = {
  providerPluginId: "ui.providerPluginId",
  selectedLocale: "ui.selectedLocale",
} as const;

export const BUILTIN_LOCALE_OPTIONS: readonly LocaleOption[] = [
  {
    builtIn: true,
    direction: "ltr",
    locale: "zh",
    nativeName: "中文",
    pluginId: "builtin.zh",
  },
  {
    builtIn: true,
    direction: "ltr",
    locale: "en",
    nativeName: "English",
    pluginId: "builtin.en",
  },
] as const;

const BUILTIN_MAIN_CATALOGS: Record<string, MainLocaleCatalog> = {
  en: {
    closeWindowQuestion: "What should happen when the window is closed?",
    closeWindowTitle: "Close window",
    launchAtStartup: "Launch at Startup",
    minimizeToTray: "Minimize to tray",
    quit: "Quit",
    showWindow: "Show Window",
    tooltip: "AI Image Manager",
  },
  zh: {
    closeWindowQuestion: "关闭窗口时要如何处理？",
    closeWindowTitle: "关闭窗口",
    launchAtStartup: "开机自启",
    minimizeToTray: "最小化到托盘",
    quit: "退出",
    showWindow: "显示窗口",
    tooltip: "AI 图片管理器",
  },
};

const LOCALE_STRING_LIMIT = 16_384;
const LOCALE_ARRAY_LIMIT = 2048;
const LOCALE_OBJECT_LIMIT = 2048;
const LOCALE_DEPTH_LIMIT = 32;
const LOCALE_LEAF_LIMIT = 50_000;
const LOCALE_DANGEROUS_TEXT_PATTERN =
  /(?:<\/?[a-z][^>]*>|javascript\s*:|vbscript\s*:|data\s*:\s*text\/html)/i;
const PROVIDER_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const UNSAFE_CATALOG_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function getBuiltinMainCatalog(locale: string): MainLocaleCatalog {
  return BUILTIN_MAIN_CATALOGS[locale] ?? {};
}

export function isBuiltinLocale(locale: string): boolean {
  return BUILTIN_LOCALE_OPTIONS.some((option) => option.locale === locale);
}

/**
 * Canonicalize a BCP-47 tag while keeping the host's short built-in aliases.
 * Invalid tags are rejected instead of being passed to Intl or i18next.
 */
export function normalizeLocaleTag(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64 || trimmed.includes("\\")) {
    return null;
  }
  if (trimmed.toLowerCase() === "zh") {
    return "zh";
  }
  if (trimmed.toLowerCase() === "en") {
    return "en";
  }
  try {
    const [canonical] = Intl.getCanonicalLocales(trimmed);
    return canonical ?? null;
  } catch {
    return null;
  }
}

function isPlainRecord(value: unknown): value is LocaleCatalogObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeText(value: string): boolean {
  return (
    value.length <= LOCALE_STRING_LIMIT &&
    !hasLocaleControl(value) &&
    !LOCALE_DANGEROUS_TEXT_PATTERN.test(value)
  );
}

function hasLocaleControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      (code >= 0x7f && code <= 0x9f)
    ) {
      return true;
    }
  }
  return false;
}

function isSafeProviderId(value: string): boolean {
  return (
    value.length <= 160 &&
    PROVIDER_ID_PATTERN.test(value) &&
    !value.includes("\\")
  );
}

function isCatalogValue(
  value: unknown,
  depth = 0,
  state = { leaves: 0 }
): boolean {
  if (depth > LOCALE_DEPTH_LIMIT) {
    return false;
  }
  if (typeof value === "string") {
    state.leaves += 1;
    return state.leaves <= LOCALE_LEAF_LIMIT && isSafeText(value);
  }
  if (Array.isArray(value)) {
    return (
      value.length <= LOCALE_ARRAY_LIMIT &&
      value.every((item) => isCatalogValue(item, depth + 1, state))
    );
  }
  if (!isPlainRecord(value)) {
    return false;
  }
  return (
    Object.keys(value).length <= LOCALE_OBJECT_LIMIT &&
    Object.entries(value).every(
      ([key, child]) =>
        key.length > 0 &&
        key.length <= 256 &&
        !hasLocaleControl(key) &&
        !UNSAFE_CATALOG_KEYS.has(key) &&
        isCatalogValue(child, depth + 1, state)
    )
  );
}

function readMainCatalog(value: unknown): MainLocaleCatalog | null {
  if (!(isPlainRecord(value) && isCatalogValue(value))) {
    return null;
  }
  const output: MainLocaleCatalog = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string") {
      output[key] = child;
    }
  }
  return output;
}

/**
 * Validate and normalize the canonical provider response exposed by the
 * plugin-manager adapter. The adapter performs the one explicit mapping from
 * the manager's manifest terminology (`tag`/`pluginId`) to this shared catalog
 * terminology; this function itself has a single strict shape.
 */
export function validateLocaleBundle(
  value: unknown,
  expected?: { locale?: string; pluginId?: string }
): LocaleBundle | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  const locale = normalizeLocaleTag(value.locale);
  const providerPluginId =
    typeof value.providerPluginId === "string" ? value.providerPluginId : "";
  const nativeName =
    typeof value.nativeName === "string" ? value.nativeName : "";
  const direction = value.direction === undefined ? "ltr" : value.direction;
  const renderer = value.renderer;
  const main = value.main;
  const version = typeof value.version === "string" ? value.version : undefined;
  if (
    !(
      locale &&
      providerPluginId &&
      isSafeProviderId(providerPluginId) &&
      nativeName.length > 0 &&
      isSafeText(nativeName)
    ) ||
    nativeName.length > 256 ||
    direction !== "ltr" ||
    !isPlainRecord(renderer) ||
    !isCatalogValue(renderer) ||
    !isPlainRecord(main) ||
    !isCatalogValue(main) ||
    (expected?.locale &&
      locale !== (normalizeLocaleTag(expected.locale) ?? expected.locale)) ||
    (expected?.pluginId && providerPluginId !== expected.pluginId)
  ) {
    return null;
  }
  const mainCatalog = readMainCatalog(main);
  if (!mainCatalog) {
    return null;
  }
  return {
    direction,
    locale,
    main: mainCatalog,
    nativeName,
    providerPluginId,
    renderer,
    ...(version ? { version } : {}),
  };
}

export function validateLocaleProviderSummary(
  value: unknown
): LocaleProviderSummary | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  const locale = normalizeLocaleTag(value.locale);
  const pluginId = typeof value.pluginId === "string" ? value.pluginId : "";
  const nativeName =
    typeof value.nativeName === "string" ? value.nativeName : "";
  const direction = value.direction === undefined ? "ltr" : value.direction;
  const version = typeof value.version === "string" ? value.version : undefined;
  if (
    !(
      locale &&
      pluginId &&
      isSafeProviderId(pluginId) &&
      isSafeText(nativeName)
    ) ||
    nativeName.length > 256 ||
    direction !== "ltr"
  ) {
    return null;
  }
  return {
    direction,
    locale,
    nativeName,
    pluginId,
    ...(version ? { version } : {}),
  };
}
