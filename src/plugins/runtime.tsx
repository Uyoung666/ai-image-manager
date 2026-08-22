import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { FilterDropdown } from "@/components/filter-dropdown";
import { Switch } from "@/components/ui/switch";
import { ipc } from "@/ipc/manager";
import {
  NebulaGlassPlugin,
  NebulaGlassSettings,
} from "./builtins/nebula-glass";
import {
  migrateNebulaGlassSettings,
  NEBULA_GLASS_MANIFEST,
} from "./builtins/nebula-glass-manifest";
import {
  getLocalizedText,
  THEME_TOKEN_MAP,
  validatePluginSettings,
} from "./manifest";
import type {
  BuiltinPlugin,
  PluginRecord,
  PluginSettingDefinition,
  PluginSnapshot,
} from "./types";

const BUILTIN_PLUGINS: Record<string, BuiltinPlugin> = {
  [NebulaGlassPlugin.id]: NebulaGlassPlugin,
};
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

interface PluginHostValue {
  activePlugin?: PluginRecord;
  disable: (pluginId: string) => Promise<void>;
  enable: (pluginId: string) => Promise<void>;
  install: () => Promise<void>;
  loading: boolean;
  plugins: PluginRecord[];
  selectAsset: (pluginId: string, settingId: string) => Promise<void>;
  setSettings: (
    pluginId: string,
    settings: Record<string, boolean | number | string>
  ) => Promise<void>;
  uninstall: (pluginId: string) => Promise<void>;
}

const PluginHostContext = createContext<PluginHostValue | null>(null);

function readStartupSnapshot(): PluginSnapshot {
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
  const [snapshot, setSnapshot] = useState<PluginSnapshot>(readStartupSnapshot);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    ipc.client.plugins
      .list({})
      .then(setSnapshot)
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  return { loading, setSnapshot, snapshot };
}

export function PluginHostProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { loading, setSnapshot, snapshot } = usePluginSnapshot();
  const activePlugin = snapshot.plugins.find(
    (plugin) => plugin.status === "active"
  );

  useEffect(() => {
    const root = document.documentElement;
    if (!activePlugin && loading) {
      return;
    }
    root.toggleAttribute("data-plugin-active", Boolean(activePlugin));
    if (activePlugin) {
      root.dataset.activePlugin = activePlugin.manifest.id;
      if (activePlugin.manifest.id !== NebulaGlassPlugin.id) {
        root.removeAttribute("data-nebula-glass");
      }
    } else {
      root.removeAttribute("data-active-plugin");
      root.removeAttribute("data-nebula-glass");
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
  }, [activePlugin, loading]);

  const value = useMemo<PluginHostValue>(() => {
    const apply = (next: PluginSnapshot) => setSnapshot(next);
    return {
      activePlugin,
      disable: async (pluginId) =>
        apply(
          await ipc.client.plugins.setEnabled({ enabled: false, pluginId })
        ),
      enable: async (pluginId) =>
        apply(await ipc.client.plugins.setEnabled({ enabled: true, pluginId })),
      install: async () =>
        apply(await ipc.client.plugins.installFromDialog({})),
      loading,
      plugins: snapshot.plugins,
      selectAsset: async (pluginId, settingId) =>
        apply(await ipc.client.plugins.selectAsset({ pluginId, settingId })),
      setSettings: async (pluginId, settings) =>
        apply(await ipc.client.plugins.setSettings({ pluginId, settings })),
      uninstall: async (pluginId) =>
        apply(await ipc.client.plugins.uninstall({ pluginId })),
    };
  }, [activePlugin, loading, setSnapshot, snapshot.plugins]);

  useEffect(() => {
    if (!activePlugin) {
      return;
    }
    const builtin = BUILTIN_PLUGINS[activePlugin.manifest.id];
    if (!builtin) {
      return;
    }
    const context = {
      getSetting: (id: string) => activePlugin.settings[id],
      onSettingsChanged: () => () => undefined,
      root: document.documentElement,
      setRootAttribute: (name: string, value: string | null) => {
        if (value === null) {
          document.documentElement.removeAttribute(name);
        } else {
          document.documentElement.setAttribute(name, value);
        }
      },
    };
    let dispose: (() => void) | undefined;
    try {
      const activated = builtin.activate(context);
      dispose = typeof activated === "function" ? activated : undefined;
    } catch (error) {
      console.error(
        `[plugin] ${getLocalizedText(activePlugin.manifest.name, navigator.language)} failed to activate`,
        error
      );
      ipc.client.plugins
        .setEnabled({ enabled: false, pluginId: activePlugin.manifest.id })
        .then(setSnapshot)
        .catch(() => undefined);
      return;
    }
    return () => {
      if (typeof dispose === "function") {
        dispose();
      }
    };
  }, [activePlugin, setSnapshot]);

  useEffect(() => {
    const active = activePlugin;
    if (!active || active.source !== "local") {
      return;
    }
    const builtin = BUILTIN_PLUGINS[active.manifest.id];
    if (builtin) {
      return;
    }
    const root = document.documentElement;
    const previous = new Map<string, string>();
    for (const [key, value] of Object.entries(
      active.manifest.theme.tokens ?? {}
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
  }, [activePlugin]);

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

export function PluginBackdropHost() {
  const { activePlugin } = usePluginHost();
  if (!activePlugin) {
    return null;
  }
  const builtin = BUILTIN_PLUGINS[activePlugin.manifest.id];
  return builtin ? (
    builtin.renderBackdrop({ record: activePlugin })
  ) : (
    <DeclarativePluginBackdrop record={activePlugin} />
  );
}

export function PluginSettingsSlot({ slot }: { slot: "plugin.settings" }) {
  const { activePlugin, selectAsset, setSettings } = usePluginHost();
  if (!activePlugin || slot !== "plugin.settings") {
    return null;
  }
  const builtin = BUILTIN_PLUGINS[activePlugin.manifest.id];
  let settingsContent: React.ReactNode;
  if (activePlugin.manifest.id === NebulaGlassPlugin.id) {
    settingsContent = (
      <NebulaGlassPluginSettings
        onAssetSelect={selectAsset}
        onChange={setSettings}
        record={activePlugin}
      />
    );
  } else if (builtin) {
    settingsContent = builtin.renderSettings({ record: activePlugin });
  } else {
    settingsContent = (
      <DeclarativePluginSettings
        onAssetSelect={(settingId) => {
          selectAsset(activePlugin.manifest.id, settingId).catch(
            () => undefined
          );
        }}
        onChange={(settings) => {
          setSettings(activePlugin.manifest.id, settings).catch(
            () => undefined
          );
        }}
        record={activePlugin}
      />
    );
  }
  // The plugin page owns the surrounding settings surface. Keeping another
  // card here would create coincident rounded borders in Mica mode.
  return <div className="min-w-0 px-0.5 py-1 sm:px-1">{settingsContent}</div>;
}

function DeclarativeControl({
  definition,
  language,
  label,
  onAssetSelect,
  onChange,
  record,
  value,
}: {
  definition: PluginSettingDefinition;
  language: string;
  label: string;
  onAssetSelect: (settingId: string) => void;
  onChange: (value: boolean | number | string) => void;
  record: PluginRecord;
  value: boolean | number | string;
}) {
  const { t } = useTranslation();
  if (definition.type === "boolean") {
    return (
      <Switch
        ariaLabel={label}
        checked={value === true}
        onCheckedChange={onChange}
      />
    );
  }
  if (definition.type === "select") {
    return (
      <FilterDropdown
        ariaLabel={label}
        className="w-[150px] max-w-full"
        onChange={onChange}
        options={(definition.options ?? []).map((option) => ({
          label: getLocalizedText(option.label, language),
          value: option.value,
        }))}
        placeholder={label}
        value={String(value)}
      />
    );
  }
  if (definition.type === "number") {
    return (
      <input
        aria-label={label}
        className="w-[150px] accent-primary"
        max={definition.max}
        min={definition.min}
        onChange={(event) => onChange(Number(event.target.value))}
        step={definition.step}
        type="range"
        value={Number(value)}
      />
    );
  }
  if (definition.type === "color") {
    return (
      <input
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
        type="color"
        value={
          typeof value === "string" && HEX_COLOR_PATTERN.test(value)
            ? value
            : "#6d7cff"
        }
      />
    );
  }
  if (definition.type === "image" || definition.type === "video") {
    let buttonLabel = t("settingsPluginsChooseVideo");
    if (record.assetUrls[definition.id]) {
      buttonLabel = t("settingsPluginsReplaceFile");
    } else if (definition.type === "image") {
      buttonLabel = t("settingsPluginsChooseImage");
    }
    return (
      <button
        className="rounded-[6px] border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted"
        onClick={() => onAssetSelect(definition.id)}
        type="button"
      >
        {buttonLabel}
      </button>
    );
  }
  return null;
}

function DeclarativePluginSettings({
  onAssetSelect,
  onChange,
  record,
}: {
  onAssetSelect: (settingId: string) => void;
  onChange: (settings: Record<string, boolean | number | string>) => void;
  record: PluginRecord;
}) {
  const { i18n } = useTranslation();
  const localized = (value: { en: string; zh: string }) =>
    getLocalizedText(value, i18n.language);
  const update = (
    definition: PluginSettingDefinition,
    value: boolean | number | string
  ) => onChange({ ...record.settings, [definition.id]: value });

  return (
    <div className="nebula-glass-settings-grid">
      {record.manifest.settings.map((definition) => {
        const value = record.settings[definition.id] ?? definition.defaultValue;
        const label = localized(definition.label);
        const control = (
          <DeclarativeControl
            definition={definition}
            label={label}
            language={i18n.language}
            onAssetSelect={onAssetSelect}
            onChange={(value) => update(definition, value)}
            record={record}
            value={value}
          />
        );
        return (
          <div className="nebula-glass-setting" key={definition.id}>
            <div>
              <div className="text-[12px] text-foreground">{label}</div>
              {definition.description ? (
                <div className="text-[11px] text-muted-foreground">
                  {localized(definition.description)}
                </div>
              ) : null}
            </div>
            {control}
          </div>
        );
      })}
    </div>
  );
}

function DeclarativePluginBackdrop({ record }: { record: PluginRecord }) {
  const effect = record.manifest.theme.backdrop?.effect;
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
    if (reduceMotion || document.visibilityState !== "visible") {
      video.pause();
    } else {
      video.play().catch(() => undefined);
    }
    const sync = () => {
      if (reduceMotion || document.visibilityState !== "visible") {
        video.pause();
      } else {
        video.play().catch(() => undefined);
      }
    };
    document.addEventListener("visibilitychange", sync);
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

function NebulaGlassPluginSettings({
  onAssetSelect,
  onChange,
  record,
}: {
  onAssetSelect: (pluginId: string, settingId: string) => Promise<void>;
  onChange: (
    pluginId: string,
    settings: Record<string, boolean | number | string>
  ) => Promise<void>;
  record: PluginRecord;
}) {
  return (
    <NebulaGlassSettings
      onAssetSelect={(settingId) => {
        onAssetSelect(record.manifest.id, settingId).catch(() => undefined);
      }}
      onChange={(settings) => {
        onChange(record.manifest.id, settings).catch(() => undefined);
      }}
      record={record}
    />
  );
}
