import { randomUUID } from "node:crypto";
import { app } from "electron";
import Store from "electron-store";
import {
  deleteSetting,
  getSetting,
  setSetting,
} from "@/services/settings-manager";
import {
  BUILTIN_LOCALE_OPTIONS,
  getBuiltinMainCatalog,
  isBuiltinLocale,
  LOCALE_SETTINGS_KEYS,
  type LocaleBundle,
  type LocaleOption,
  type LocaleRuntimeState,
  normalizeLocaleTag,
} from "./catalog";
import {
  listVerifiedLocaleProviders,
  loadVerifiedLocaleProvider,
} from "./plugin-adapter";

const LEGACY_LOCALE_SETTING_KEYS = ["ui.locale", "ui.language"] as const;
const DEFAULT_LOCALE = "en";

interface LegacyTrayStore {
  language?: string;
}

interface InternalLocaleState {
  bundle: LocaleBundle | null;
  providerPluginId: string | null;
  selectedLocale: string;
}

interface PreparedSelection {
  bundle: LocaleBundle | null;
  providerPluginId: string | null;
  selectedLocale: string;
}

let currentState: InternalLocaleState | null = null;
let initialization: Promise<LocaleRuntimeState> | null = null;
let legacyStore: Store<LegacyTrayStore> | null = null;
let selectionWasPersisted = false;
let previewBackup: InternalLocaleState | null = null;
const preparedSelections = new Map<string, PreparedSelection>();
const localeChangedListeners = new Set<() => void>();

function getLegacyTrayStore(): Store<LegacyTrayStore> {
  if (!legacyStore) {
    legacyStore = new Store<LegacyTrayStore>({
      name: "tray-lang",
      defaults: {},
    });
  }
  return legacyStore;
}

function readPersistedSelection(): {
  locale: string | null;
  providerPluginId: string | null;
} {
  try {
    const primary = getSetting(LOCALE_SETTINGS_KEYS.selectedLocale);
    const legacy = primary
      ? null
      : LEGACY_LOCALE_SETTING_KEYS.map((key) => getSetting(key)).find(
          (value): value is string => Boolean(value)
        );
    const locale = normalizeLocaleTag(primary ?? legacy);
    const provider = getSetting(LOCALE_SETTINGS_KEYS.providerPluginId);
    return {
      locale,
      providerPluginId: provider?.trim() || null,
    };
  } catch {
    return { locale: null, providerPluginId: null };
  }
}

function readLegacyLocale(): string | null {
  try {
    return normalizeLocaleTag(getLegacyTrayStore().get("language"));
  } catch {
    return null;
  }
}

function systemLocale(): string {
  try {
    const detected = normalizeLocaleTag(app.getLocale());
    if (detected?.toLowerCase().startsWith("zh")) {
      return "zh";
    }
  } catch {
    // Electron is not fully initialized in a few unit-test/startup paths.
  }
  return DEFAULT_LOCALE;
}

function copyInternalState(state: InternalLocaleState): InternalLocaleState {
  return {
    bundle: state.bundle
      ? {
          ...state.bundle,
          main: { ...state.bundle.main },
          renderer: { ...state.bundle.renderer },
        }
      : null,
    providerPluginId: state.providerPluginId,
    selectedLocale: state.selectedLocale,
  };
}

async function availableOptions(): Promise<LocaleOption[]> {
  const providers = await listVerifiedLocaleProviders();
  const pluginOptions = providers.map((provider) => ({
    ...provider,
    builtIn: false,
  }));
  return [...BUILTIN_LOCALE_OPTIONS, ...pluginOptions];
}

function publicState(
  state: InternalLocaleState,
  available: LocaleOption[]
): LocaleRuntimeState {
  return {
    available,
    direction: state.bundle?.direction ?? "ltr",
    providerPluginId: state.providerPluginId,
    renderer: state.bundle?.renderer ?? null,
    selectedLocale: state.selectedLocale,
  };
}

function notifyLocaleChanged(): void {
  for (const listener of localeChangedListeners) {
    try {
      listener();
    } catch {
      // A tray/UI refresh must not make an already committed language fail.
    }
  }
}

function assertSelectionInput(
  localeInput: string,
  providerPluginIdInput?: string | null
): { locale: string; providerPluginId: string | null } {
  const locale = normalizeLocaleTag(localeInput);
  if (!locale) {
    throw new Error("Invalid locale");
  }
  const requestedProvider =
    typeof providerPluginIdInput === "string" && providerPluginIdInput.trim()
      ? providerPluginIdInput.trim()
      : null;
  if (isBuiltinLocale(locale)) {
    if (requestedProvider && requestedProvider !== `builtin.${locale}`) {
      throw new Error("The provider does not match the built-in locale");
    }
    return { locale, providerPluginId: null };
  }
  return { locale, providerPluginId: requestedProvider };
}

async function resolveSelection(
  localeInput: string,
  providerPluginIdInput?: string | null
): Promise<PreparedSelection> {
  const { locale, providerPluginId: requestedProvider } = assertSelectionInput(
    localeInput,
    providerPluginIdInput
  );
  if (isBuiltinLocale(locale)) {
    return { bundle: null, providerPluginId: null, selectedLocale: locale };
  }

  const providers = await listVerifiedLocaleProviders();
  const provider = providers.find(
    (candidate) =>
      candidate.locale === locale &&
      (!requestedProvider || candidate.pluginId === requestedProvider)
  );
  if (!provider) {
    throw new Error("The requested locale provider is unavailable");
  }
  const bundle = await loadVerifiedLocaleProvider(
    provider.pluginId,
    locale,
    provider.version
  );
  if (!bundle) {
    throw new Error("The requested locale provider failed validation");
  }
  return {
    bundle,
    providerPluginId: provider.pluginId,
    selectedLocale: locale,
  };
}

function persistSelection(selection: PreparedSelection): void {
  const previous = readPersistedSelection();
  try {
    setSetting(LOCALE_SETTINGS_KEYS.selectedLocale, selection.selectedLocale);
    setSetting(
      LOCALE_SETTINGS_KEYS.providerPluginId,
      selection.providerPluginId ?? ""
    );
  } catch (error) {
    // Keep both preference keys consistent if a database write is interrupted.
    try {
      if (previous.locale) {
        setSetting(LOCALE_SETTINGS_KEYS.selectedLocale, previous.locale);
      } else {
        deleteSetting(LOCALE_SETTINGS_KEYS.selectedLocale);
      }
      setSetting(
        LOCALE_SETTINGS_KEYS.providerPluginId,
        previous.providerPluginId ?? ""
      );
    } catch {
      // Preserve the original database error for the caller.
    }
    throw error;
  }
}

async function ensureInitialized(
  legacyHint?: string | null
): Promise<LocaleRuntimeState> {
  const persisted = readPersistedSelection();
  const trayLocale = readLegacyLocale();
  const hinted = normalizeLocaleTag(legacyHint);
  const selectedLocale =
    persisted.locale ?? trayLocale ?? hinted ?? systemLocale();
  selectionWasPersisted = Boolean(persisted.locale || trayLocale || hinted);
  const providerPluginId = persisted.locale ? persisted.providerPluginId : null;
  let selection: PreparedSelection;
  let usedFallback = false;
  try {
    selection = await resolveSelection(selectedLocale, providerPluginId);
  } catch {
    // A removed, unsigned or broken provider never prevents startup.  Preserve
    // its locale when it is a built-in; otherwise fall back to system/en/zh.
    let fallbackLocale = systemLocale();
    if (isBuiltinLocale(selectedLocale)) {
      fallbackLocale = selectedLocale;
    }
    selection = await resolveSelection(fallbackLocale, null);
    usedFallback = true;
  }
  currentState = {
    bundle: selection.bundle,
    providerPluginId: selection.providerPluginId,
    selectedLocale: selection.selectedLocale,
  };
  // Migrate the old tray store/renderer hint, and repair a persisted provider
  // that disappeared or failed validation. A system default is deliberately
  // kept in memory until the first renderer handshake so an old
  // `localStorage.lang` value can still be migrated.
  const selectionDiffersFromPersisted =
    persisted.locale !== selection.selectedLocale ||
    persisted.providerPluginId !== selection.providerPluginId;
  if (
    selectionWasPersisted &&
    (usedFallback || !persisted.locale || selectionDiffersFromPersisted)
  ) {
    try {
      persistSelection(selection);
    } catch {
      // A read-only/early test database should not block rendering.
    }
  }
  const options = await availableOptions();
  return publicState(currentState, options);
}

/**
 * Re-check the active provider through PluginManager's validated API. A
 * provider can disappear or become invalid after startup (for example, when
 * it is uninstalled or its signature no longer verifies), so this check must
 * not be limited to the initial load.
 */
async function revalidateCurrentSelection(force = false): Promise<boolean> {
  if (!currentState?.providerPluginId || (!force && previewBackup)) {
    return false;
  }

  const previous = currentState;
  try {
    const selection = await resolveSelection(
      previous.selectedLocale,
      previous.providerPluginId
    );
    currentState = {
      bundle: selection.bundle,
      providerPluginId: selection.providerPluginId,
      selectedLocale: selection.selectedLocale,
    };
    const previousVersion = previous.bundle?.version;
    const nextVersion = selection.bundle?.version;
    const bundleChanged =
      JSON.stringify(previous.bundle) !== JSON.stringify(selection.bundle);
    if (previousVersion !== nextVersion || bundleChanged) {
      notifyLocaleChanged();
      return true;
    }
    return false;
  } catch {
    const fallback = await resolveSelection(systemLocale(), null);
    previewBackup = null;
    currentState = {
      bundle: fallback.bundle,
      providerPluginId: fallback.providerPluginId,
      selectedLocale: fallback.selectedLocale,
    };
    selectionWasPersisted = true;
    try {
      persistSelection(fallback);
    } catch {
      // A temporary settings/database failure must not keep an invalid
      // provider active for this process. The next refresh retries persistence.
    }
    notifyLocaleChanged();
    return true;
  }
}

async function adoptLegacyHint(legacyHint?: string | null): Promise<void> {
  const locale = normalizeLocaleTag(legacyHint);
  if (
    selectionWasPersisted ||
    !locale ||
    !isBuiltinLocale(locale) ||
    !currentState ||
    currentState.providerPluginId !== null
  ) {
    return;
  }
  const selection = await resolveSelection(locale, null);
  persistSelection(selection);
  currentState = {
    bundle: selection.bundle,
    providerPluginId: selection.providerPluginId,
    selectedLocale: selection.selectedLocale,
  };
  selectionWasPersisted = true;
  notifyLocaleChanged();
}

export async function initializeMainLocalization(
  legacyHint?: string | null
): Promise<LocaleRuntimeState> {
  if (currentState) {
    await adoptLegacyHint(legacyHint);
    return getMainLocalizationState();
  }
  initialization ??= ensureInitialized(legacyHint).finally(() => {
    initialization = null;
  });
  return initialization;
}

export async function getMainLocalizationState(
  legacyHint?: string | null
): Promise<LocaleRuntimeState> {
  if (!currentState) {
    return initializeMainLocalization(legacyHint);
  }
  await adoptLegacyHint(legacyHint);
  await revalidateCurrentSelection();
  return publicState(currentState, await availableOptions());
}

export async function listMainLocalizationOptions(): Promise<LocaleOption[]> {
  if (currentState) {
    await revalidateCurrentSelection();
  } else {
    await initializeMainLocalization();
  }
  return availableOptions();
}

/** Revalidate the active locale and return the resulting public state. */
export async function revalidateMainLocalization(): Promise<LocaleRuntimeState> {
  if (!currentState) {
    return initializeMainLocalization();
  }
  await revalidateCurrentSelection(true);
  return publicState(currentState, await availableOptions());
}

export async function prepareMainLocaleSelection(input: {
  locale: string;
  providerPluginId?: string | null;
}): Promise<{
  selectedLocale: string;
  providerPluginId: string | null;
  token: string;
}> {
  await initializeMainLocalization();
  const selection = await resolveSelection(
    input.locale,
    input.providerPluginId
  );
  const token = randomUUID();
  preparedSelections.set(token, selection);
  return {
    providerPluginId: selection.providerPluginId,
    selectedLocale: selection.selectedLocale,
    token,
  };
}

export async function commitMainLocaleSelection(input: {
  token: string;
}): Promise<LocaleRuntimeState> {
  await initializeMainLocalization();
  const selection = preparedSelections.get(input.token);
  if (!selection) {
    throw new Error("Locale selection has expired");
  }
  preparedSelections.delete(input.token);
  persistSelection(selection);
  currentState = {
    bundle: selection.bundle,
    providerPluginId: selection.providerPluginId,
    selectedLocale: selection.selectedLocale,
  };
  selectionWasPersisted = true;
  previewBackup = null;
  notifyLocaleChanged();
  return publicState(currentState, await availableOptions());
}

export async function setMainLocaleSelection(input: {
  locale: string;
  providerPluginId?: string | null;
}): Promise<LocaleRuntimeState> {
  const prepared = await prepareMainLocaleSelection(input);
  return commitMainLocaleSelection({ token: prepared.token });
}

export async function previewMainLocaleSelection(input: {
  locale: string;
  providerPluginId?: string | null;
}): Promise<LocaleRuntimeState> {
  await initializeMainLocalization();
  const selection = await resolveSelection(
    input.locale,
    input.providerPluginId
  );
  if (!previewBackup && currentState) {
    previewBackup = copyInternalState(currentState);
  }
  currentState = {
    bundle: selection.bundle,
    providerPluginId: selection.providerPluginId,
    selectedLocale: selection.selectedLocale,
  };
  notifyLocaleChanged();
  return getMainLocalizationState();
}

export async function restoreMainLocalePreview(): Promise<LocaleRuntimeState> {
  await initializeMainLocalization();
  if (previewBackup) {
    currentState = previewBackup;
    previewBackup = null;
    if (!(await revalidateCurrentSelection())) {
      notifyLocaleChanged();
    }
  } else {
    await revalidateCurrentSelection();
  }
  if (!currentState) {
    return initializeMainLocalization();
  }
  return publicState(currentState, await availableOptions());
}

/** Compatibility bridge for old renderer builds that only send a language. */
export function syncLegacyRendererLocale(value: unknown): void {
  const locale = normalizeLocaleTag(value);
  if (!(locale && isBuiltinLocale(locale))) {
    return;
  }
  setMainLocaleSelection({ locale }).catch(() => undefined);
}

export function onMainLocaleChanged(listener: () => void): () => void {
  localeChangedListeners.add(listener);
  return () => localeChangedListeners.delete(listener);
}

export function getMainLocaleText(key: string): string {
  const state = currentState;
  if (state?.bundle?.main[key] !== undefined) {
    return state.bundle.main[key] as string;
  }
  const locale = state?.selectedLocale ?? DEFAULT_LOCALE;
  return (
    getBuiltinMainCatalog(locale)[key] ??
    getBuiltinMainCatalog("en")[key] ??
    getBuiltinMainCatalog("zh")[key] ??
    key
  );
}
