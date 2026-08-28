import type { ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { revalidateAppLocale } from "@/actions/localization";
import {
  commitPluginInstall,
  discardPluginInspection,
  inspectPluginFromDialog,
  listPlugins,
  loadDevDirectoryFromDialog,
  reloadDevPlugin,
  removeDevPlugin,
  removePluginAsset,
  reportPluginActivationResult,
  resetPluginSettings,
  selectPluginAsset,
  setPluginDeveloperMode,
  setPluginEnabled,
  setPluginSettings,
  uninstallPlugin,
} from "@/actions/plugins";
import { PluginSettingsEditor } from "@/components/plugins/plugin-settings-editor";
import { NebulaGlassPlugin } from "./builtins/nebula-glass";
import {
  migrateNebulaGlassSettings,
  NEBULA_GLASS_MANIFEST,
} from "./builtins/nebula-glass-manifest";
import {
  DeclarativeThemeBackdrop,
  type DeclarativeThemeRecord,
} from "./declarative-theme";
import {
  getLocalizedText,
  THEME_TOKEN_MAP,
  validatePluginSettings,
} from "./manifest";
import type {
  BuiltinPlugin,
  BuiltinPluginContext,
  NormalizedPluginManifestV2,
  NormalizedPluginManifestV3Locale,
  PluginManifestV1,
  PluginRecord,
  PluginSettingValue,
} from "./types";

const BUILTIN_PLUGINS: Record<string, BuiltinPlugin> = {
  [NebulaGlassPlugin.id]: NebulaGlassPlugin,
};

type ThemePluginManifest = PluginManifestV1 | NormalizedPluginManifestV2;
type ThemePluginRecord = PluginRecord<ThemePluginManifest>;
type AnyPluginRecord =
  | ThemePluginRecord
  | PluginRecord<NormalizedPluginManifestV3Locale>;
interface AnyPluginSnapshot {
  plugins: AnyPluginRecord[];
}
type PluginInspection = Awaited<ReturnType<typeof inspectPluginFromDialog>>;
type PluginSettingsPatch = Record<string, PluginSettingValue>;

function isThemePluginRecord(
  record: AnyPluginRecord
): record is ThemePluginRecord {
  return record.manifest.manifestVersion !== 3;
}

interface PluginHostValue {
  activePlugin?: ThemePluginRecord;
  applySnapshotResult: (next: unknown) => void;
  clearError: () => void;
  commitInstall: (token: string) => Promise<void>;
  developerMode: boolean;
  disable: (pluginId: string) => Promise<void>;
  discardInstall: (token: string) => Promise<void>;
  enable: (pluginId: string) => Promise<void>;
  error?: unknown;
  exitPreview: () => void;
  inspectInstall: () => Promise<PluginInspection>;
  loadDeveloperDirectory: () => Promise<void>;
  loading: boolean;
  plugins: AnyPluginRecord[];
  previewId: string | null;
  previewPlugin: (pluginId: string) => void;
  previewRecord?: ThemePluginRecord;
  refresh: () => Promise<void>;
  reloadDeveloperPlugin: (pluginId: string) => Promise<void>;
  removeAsset: (pluginId: string, settingId: string) => Promise<void>;
  removeDeveloperPlugin: (pluginId: string) => Promise<void>;
  reportError: (error: unknown) => void;
  resetSettings: (pluginId: string, settingIds?: string[]) => Promise<void>;
  selectAsset: (pluginId: string, settingId: string) => Promise<void>;
  selectedId: string | null;
  selectedPlugin?: AnyPluginRecord;
  selectPlugin: (pluginId: string) => void;
  setDeveloperMode: (enabled: boolean) => Promise<void>;
  setSettings: (
    pluginId: string,
    settings: PluginSettingsPatch
  ) => Promise<void>;
  uninstall: (pluginId: string, removeData?: boolean) => Promise<void>;
}

const PluginHostContext = createContext<PluginHostValue | null>(null);

function readStartupSnapshot(): AnyPluginSnapshot {
  try {
    if (localStorage.getItem("plugins.active") !== NebulaGlassPlugin.id) {
      return { plugins: [] };
    }
    const cachedSettings = localStorage.getItem("plugins.settings");
    const parsed = cachedSettings
      ? (JSON.parse(cachedSettings) as Record<string, unknown>)
      : {};
    const migrated = migrateNebulaGlassSettings(parsed);
    if (JSON.stringify(migrated) !== JSON.stringify(parsed)) {
      localStorage.setItem("plugins.settings", JSON.stringify(migrated));
    }
    return {
      plugins: [
        {
          assetUrls: {},
          enabled: true,
          manifest: NEBULA_GLASS_MANIFEST,
          settings: validatePluginSettings(NEBULA_GLASS_MANIFEST, migrated),
          source: "builtin",
          status: "active",
        },
      ],
    };
  } catch {
    return { plugins: [] };
  }
}

function usePluginSnapshot() {
  const [snapshot, setSnapshot] =
    useState<AnyPluginSnapshot>(readStartupSnapshot);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    let mounted = true;
    listPlugins()
      .then((next) => {
        if (mounted) {
          setSnapshot(next as AnyPluginSnapshot);
          setError(undefined);
        }
      })
      .catch((reason: unknown) => {
        if (mounted) {
          setError(reason);
        }
      })
      .finally(() => {
        if (mounted) {
          setLoading(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  return { error, loading, setError, setSnapshot, snapshot };
}

function createBuiltinContext(record: ThemePluginRecord): BuiltinPluginContext {
  return {
    getSetting: (id) => {
      const value = record.settings[id];
      return typeof value === "boolean" ||
        typeof value === "number" ||
        typeof value === "string"
        ? value
        : undefined;
    },
    onSettingsChanged: () => () => undefined,
    root: document.documentElement,
    setRootAttribute: (name, value) => {
      if (value === null) {
        document.documentElement.removeAttribute(name);
      } else {
        document.documentElement.setAttribute(name, value);
      }
    },
  };
}

export function PluginHostProvider({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation();
  const {
    error,
    loading: snapshotLoading,
    setError,
    setSnapshot,
    snapshot,
  } = usePluginSnapshot();
  const [busy, setBusy] = useState(false);
  const busyCountRef = useRef(0);
  const settingsQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [developerMode, setDeveloperModeState] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const activePlugin = snapshot.plugins.find(
    (plugin): plugin is ThemePluginRecord =>
      plugin.status === "active" && isThemePluginRecord(plugin)
  );
  const selectedPlugin = snapshot.plugins.find(
    (plugin) => plugin.manifest.id === selectedId
  );
  const previewRecord = snapshot.plugins.find(
    (plugin): plugin is ThemePluginRecord =>
      plugin.manifest.id === previewId && isThemePluginRecord(plugin)
  );
  const effectiveRecord = previewRecord ?? activePlugin;

  useEffect(() => {
    setSelectedId((current) => {
      if (
        current &&
        snapshot.plugins.some((plugin) => plugin.manifest.id === current)
      ) {
        return current;
      }
      return (
        activePlugin?.manifest.id ?? snapshot.plugins[0]?.manifest.id ?? null
      );
    });
  }, [activePlugin?.manifest.id, snapshot.plugins]);

  useEffect(() => {
    if (previewId && !previewRecord) {
      setPreviewId(null);
    }
  }, [previewId, previewRecord]);

  useEffect(() => {
    const root = document.documentElement;
    if (!activePlugin && snapshotLoading) {
      return;
    }
    root.toggleAttribute("data-plugin-active", Boolean(activePlugin));
    if (activePlugin) {
      root.dataset.activePlugin = activePlugin.manifest.id;
      if (activePlugin.manifest.id !== NebulaGlassPlugin.id) {
        root.removeAttribute("data-nebula-glass");
        root.removeAttribute("data-nebula-mode");
      }
    } else {
      root.removeAttribute("data-active-plugin");
      root.removeAttribute("data-nebula-glass");
      root.removeAttribute("data-nebula-mode");
    }
    try {
      if (activePlugin) {
        localStorage.setItem("plugins.active", activePlugin.manifest.id);
        localStorage.setItem(
          "plugins.settings",
          JSON.stringify(activePlugin.settings)
        );
      } else {
        localStorage.removeItem("plugins.active");
        localStorage.removeItem("plugins.settings");
      }
    } catch {
      // Startup cache is an optimization; SQLite remains authoritative.
    }
  }, [activePlugin, snapshotLoading]);

  const applySnapshot = useCallback(
    async <T,>(operation: () => Promise<T>) => {
      busyCountRef.current += 1;
      setBusy(true);
      try {
        const next = await operation();
        if (next && typeof next === "object" && "plugins" in next) {
          setSnapshot(next as AnyPluginSnapshot);
        }
        return next;
      } finally {
        busyCountRef.current = Math.max(0, busyCountRef.current - 1);
        if (busyCountRef.current === 0) {
          setBusy(false);
        }
      }
    },
    [setSnapshot]
  );

  const applySnapshotOnly = useCallback(
    async (operation: () => Promise<unknown>) => {
      await applySnapshot(operation);
    },
    [applySnapshot]
  );

  const applyLocaleAwareSnapshot = useCallback(
    async (operation: () => Promise<unknown>) => {
      await applySnapshotOnly(operation);
      await revalidateAppLocale(i18n);
    },
    [applySnapshotOnly, i18n]
  );

  const selectPlugin = useCallback((pluginId: string) => {
    setSelectedId(pluginId);
  }, []);

  const previewPlugin = useCallback(
    (pluginId: string) => {
      const plugin = snapshot.plugins.find(
        (candidate) => candidate.manifest.id === pluginId
      );
      if (!(plugin && isThemePluginRecord(plugin))) {
        return;
      }
      if (plugin.status === "incompatible" || plugin.status === "invalid") {
        return;
      }
      setSelectedId(pluginId);
      setPreviewId(pluginId);
    },
    [snapshot.plugins]
  );

  const exitPreview = useCallback(() => {
    setPreviewId(null);
  }, []);

  const enable = useCallback(
    async (pluginId: string) => {
      const plugin = snapshot.plugins.find(
        (candidate) => candidate.manifest.id === pluginId
      );
      if (!(plugin && isThemePluginRecord(plugin))) {
        return;
      }
      await applySnapshotOnly(() => setPluginEnabled(pluginId, true));
      setPreviewId((current) => (current === pluginId ? null : current));
    },
    [applySnapshotOnly, snapshot.plugins]
  );

  const disable = useCallback(
    async (pluginId: string) => {
      const plugin = snapshot.plugins.find(
        (candidate) => candidate.manifest.id === pluginId
      );
      if (!(plugin && isThemePluginRecord(plugin))) {
        return;
      }
      await applySnapshotOnly(() => setPluginEnabled(pluginId, false));
    },
    [applySnapshotOnly, snapshot.plugins]
  );

  const inspectInstall = useCallback(
    () => applySnapshot(inspectPluginFromDialog),
    [applySnapshot]
  );

  const commitInstall = useCallback(
    async (token: string) => {
      await applyLocaleAwareSnapshot(() => commitPluginInstall(token));
    },
    [applyLocaleAwareSnapshot]
  );

  const discardInstall = useCallback(
    async (token: string) => {
      await applySnapshot(discardPluginInspection.bind(null, token));
    },
    [applySnapshot]
  );

  const refresh = useCallback(
    () => applyLocaleAwareSnapshot(listPlugins),
    [applyLocaleAwareSnapshot]
  );

  const setSettings = useCallback(
    async (pluginId: string, settings: PluginSettingsPatch) => {
      const task = settingsQueueRef.current
        .catch(() => undefined)
        .then(() =>
          applySnapshotOnly(() => setPluginSettings(pluginId, settings))
        );
      settingsQueueRef.current = task;
      await task;
    },
    [applySnapshotOnly]
  );

  const selectAsset = useCallback(
    async (pluginId: string, settingId: string) => {
      await applySnapshotOnly(() => selectPluginAsset(pluginId, settingId));
    },
    [applySnapshotOnly]
  );

  const removeAsset = useCallback(
    async (pluginId: string, settingId: string) => {
      await applySnapshotOnly(() => removePluginAsset(pluginId, settingId));
    },
    [applySnapshotOnly]
  );

  const resetSettings = useCallback(
    async (pluginId: string, settingIds?: string[]) => {
      await applySnapshotOnly(() => resetPluginSettings(pluginId, settingIds));
    },
    [applySnapshotOnly]
  );

  const uninstall = useCallback(
    async (pluginId: string, removeData = true) => {
      await applyLocaleAwareSnapshot(() =>
        uninstallPlugin(pluginId, removeData)
      );
      setPreviewId((current) => (current === pluginId ? null : current));
    },
    [applyLocaleAwareSnapshot]
  );

  const setDeveloperMode = useCallback(
    async (enabled: boolean) => {
      await applyLocaleAwareSnapshot(() => setPluginDeveloperMode(enabled));
      setDeveloperModeState(enabled);
    },
    [applyLocaleAwareSnapshot]
  );

  const loadDeveloperDirectory = useCallback(
    () => applyLocaleAwareSnapshot(loadDevDirectoryFromDialog),
    [applyLocaleAwareSnapshot]
  );

  const reloadDeveloperPlugin = useCallback(
    (pluginId: string) =>
      applyLocaleAwareSnapshot(() => reloadDevPlugin(pluginId)),
    [applyLocaleAwareSnapshot]
  );

  const removeDeveloperPlugin = useCallback(
    (pluginId: string) =>
      applyLocaleAwareSnapshot(() => removeDevPlugin(pluginId)),
    [applyLocaleAwareSnapshot]
  );

  const clearError = useCallback(() => setError(undefined), [setError]);
  const applySnapshotResult = useCallback(
    (next: unknown) => {
      if (next && typeof next === "object" && "plugins" in next) {
        setSnapshot(next as AnyPluginSnapshot);
      }
    },
    [setSnapshot]
  );
  const reportError = useCallback(
    (reason: unknown) => setError(reason),
    [setError]
  );

  useEffect(() => {
    const record = effectiveRecord;
    if (!record) {
      return;
    }
    const builtin = BUILTIN_PLUGINS[record.manifest.id];
    let dispose: (() => void) | undefined;
    try {
      if (builtin) {
        const activated = builtin.activate(createBuiltinContext(record));
        dispose = typeof activated === "function" ? activated : undefined;
      }
    } catch (reason) {
      console.error(
        `[plugin] ${getLocalizedText(record.manifest.name, navigator.language)} failed to activate`,
        reason
      );
      if (record.source === "local" || record.source === "dev") {
        reportPluginActivationResult(
          record.manifest.id,
          record.manifest.version,
          false,
          "activation-failed",
          reason instanceof Error ? reason.message : String(reason)
        )
          .then(applySnapshotResult)
          .catch((reportErrorReason) => setError(reportErrorReason));
      } else if (record.status === "active") {
        setPluginEnabled(record.manifest.id, false)
          .then(applySnapshotResult)
          .catch((activationError) => setError(activationError));
      }
    }
    return () => {
      dispose?.();
    };
  }, [applySnapshotResult, effectiveRecord, setError]);

  const value = useMemo<PluginHostValue>(
    () => ({
      activePlugin,
      applySnapshotResult,
      clearError,
      commitInstall,
      developerMode,
      discardInstall,
      disable,
      enable,
      error,
      exitPreview,
      inspectInstall,
      loading: snapshotLoading || busy,
      loadDeveloperDirectory,
      plugins: snapshot.plugins,
      previewId,
      previewPlugin,
      previewRecord,
      refresh,
      reportError,
      reloadDeveloperPlugin,
      removeAsset,
      removeDeveloperPlugin,
      resetSettings,
      selectAsset,
      selectedId,
      selectedPlugin,
      selectPlugin,
      setDeveloperMode,
      setSettings,
      uninstall,
    }),
    [
      activePlugin,
      applySnapshotResult,
      busy,
      clearError,
      commitInstall,
      developerMode,
      discardInstall,
      disable,
      enable,
      error,
      exitPreview,
      inspectInstall,
      loadDeveloperDirectory,
      previewId,
      previewPlugin,
      previewRecord,
      refresh,
      reportError,
      reloadDeveloperPlugin,
      removeAsset,
      removeDeveloperPlugin,
      resetSettings,
      selectAsset,
      selectedId,
      selectedPlugin,
      selectPlugin,
      setDeveloperMode,
      setSettings,
      snapshot.plugins,
      snapshotLoading,
      uninstall,
    ]
  );

  return (
    <PluginHostContext.Provider value={value}>
      {children}
    </PluginHostContext.Provider>
  );
}

export function usePluginHost(): PluginHostValue {
  const context = useContext(PluginHostContext);
  if (!context) {
    throw new Error("usePluginHost must be used inside PluginHostProvider");
  }
  return context;
}

function LegacyThemeHost({ record }: { record: AnyPluginRecord }) {
  useLayoutEffect(() => {
    if (record.manifest.manifestVersion !== 1) {
      return;
    }
    const root = document.documentElement;
    const previous = new Map<string, string>();
    for (const [key, value] of Object.entries(
      record.manifest.theme.tokens ?? {}
    )) {
      const cssVariable = THEME_TOKEN_MAP[key];
      if (!cssVariable) {
        continue;
      }
      previous.set(cssVariable, root.style.getPropertyValue(cssVariable));
      root.style.setProperty(cssVariable, value);
    }
    return () => {
      for (const [cssVariable, value] of previous) {
        if (value) {
          root.style.setProperty(cssVariable, value);
        } else {
          root.style.removeProperty(cssVariable);
        }
      }
    };
  }, [record]);
  return null;
}

export function PluginBackdropHost() {
  const { activePlugin, previewRecord } = usePluginHost();
  const record = previewRecord ?? activePlugin;
  if (!record) {
    return null;
  }
  const builtin = BUILTIN_PLUGINS[record.manifest.id];
  if (builtin) {
    return (
      <>
        {builtin.renderBackdrop({
          record: record as unknown as PluginRecord,
        })}
      </>
    );
  }
  if (record.manifest.manifestVersion === 2) {
    return (
      <>
        <DeclarativeActivationReport record={record} />
        <DeclarativeThemeBackdrop
          record={record as unknown as DeclarativeThemeRecord}
        />
      </>
    );
  }
  return (
    <>
      <LegacyThemeHost record={record} />
      <DeclarativeActivationReport record={record} />
      <DeclarativePluginBackdrop record={record} />
    </>
  );
}

function DeclarativeActivationReport({
  record,
}: {
  record: ThemePluginRecord;
}) {
  const { applySnapshotResult, reportError } = usePluginHost();
  const reported = useRef(new Set<string>());
  useEffect(() => {
    if (record.source !== "local" && record.source !== "dev") {
      return;
    }
    const key = `${record.manifest.id}@${record.manifest.version}`;
    if (reported.current.has(key)) {
      return;
    }
    reported.current.add(key);
    reportPluginActivationResult(
      record.manifest.id,
      record.manifest.version,
      true
    )
      .then(applySnapshotResult)
      .catch(reportError);
  }, [applySnapshotResult, record, reportError]);
  return null;
}

function DeclarativePluginBackdrop({ record }: { record: ThemePluginRecord }) {
  const effect =
    record.manifest.manifestVersion === 1
      ? record.manifest.theme.backdrop?.effect
      : undefined;
  const asset = record.assetUrls.backdrop;
  const videoRef = useRef<HTMLVideoElement>(null);
  const reduceMotion =
    document.documentElement.dataset.reducedMotion === "true" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  useEffect(() => {
    const video = videoRef.current;
    if (!(video && effect === "video" && asset)) {
      return;
    }
    const sync = () => {
      if (reduceMotion || document.visibilityState !== "visible") {
        video.pause();
      } else {
        video.play().catch(() => undefined);
      }
    };
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      document.removeEventListener("visibilitychange", sync);
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [asset, effect, reduceMotion]);
  return (
    <div aria-hidden="true" className="plugin-declarative-backdrop">
      {effect === "image" && asset ? (
        <img
          alt=""
          className="plugin-declarative-backdrop-asset"
          height={1080}
          key={asset}
          src={asset}
          width={1920}
        />
      ) : null}
      {effect === "video" && asset ? (
        <video
          autoPlay={!reduceMotion}
          className="plugin-declarative-backdrop-asset"
          key={asset}
          loop
          muted
          playsInline
          ref={videoRef}
          src={asset}
        />
      ) : null}
      {effect === "aurora" || !effect ? (
        <div className="plugin-declarative-backdrop-aurora" />
      ) : null}
    </div>
  );
}

export function PluginSettingsSlot({
  onError,
  slot,
}: {
  onError?: (error: unknown) => void;
  slot: "plugin.settings";
}) {
  const {
    removeAsset,
    resetSettings,
    selectAsset,
    selectedPlugin,
    setSettings,
  } = usePluginHost();
  const { i18n, t } = useTranslation();
  if (
    !selectedPlugin ||
    slot !== "plugin.settings" ||
    !isThemePluginRecord(selectedPlugin)
  ) {
    return null;
  }
  const pluginId = selectedPlugin.manifest.id;
  const reset = async (scope: "all" | "group" | "setting", id?: string) => {
    try {
      if (scope === "all") {
        await resetSettings(pluginId);
        return;
      }
      if (scope === "setting" && id) {
        await resetSettings(pluginId, [id]);
        return;
      }
      if (scope === "group" && id) {
        const settingIds = selectedPlugin.manifest.settings
          .filter((setting) => setting.group === id)
          .map((setting) => setting.id);
        await resetSettings(pluginId, settingIds);
      }
    } catch (reason) {
      onError?.(reason);
    }
  };
  return (
    <div className="min-w-0 px-0.5 py-1 sm:px-1">
      <PluginSettingsEditor
        labels={{
          chooseImage: t("settingsPluginsChooseImage"),
          chooseVideo: t("settingsPluginsChooseVideo"),
          removeAsset: t("pluginSettingsRemoveAsset"),
          replaceAsset: t("settingsPluginsReplaceFile"),
          resetAll: t("pluginSettingsResetAll"),
          resetGroup: t("pluginSettingsResetGroup"),
          resetSetting: t("pluginSettingsResetSetting"),
        }}
        language={i18n.language}
        onError={onError}
        onPatch={(patch) => setSettings(pluginId, patch)}
        onRemoveAsset={(settingId) => removeAsset(pluginId, settingId)}
        onReset={reset}
        onSelectAsset={(settingId) => selectAsset(pluginId, settingId)}
        record={selectedPlugin}
      />
    </div>
  );
}
