import type { ReactNode } from "react";

export type PluginSource = "builtin" | "local";

export type PluginStatus =
  | "disabled"
  | "active"
  | "incompatible"
  | "invalid"
  | "failed";

export type PluginCapability = "theme";

export type PluginSettingType =
  | "boolean"
  | "number"
  | "select"
  | "color"
  | "image"
  | "video";

export interface LocalizedText {
  en: string;
  zh: string;
}

export interface PluginSettingOption {
  label: LocalizedText;
  value: string;
}

export interface PluginSettingDefinition {
  defaultValue: boolean | number | string;
  description?: LocalizedText;
  id: string;
  label: LocalizedText;
  max?: number;
  min?: number;
  options?: PluginSettingOption[];
  step?: number;
  type: PluginSettingType;
}

export interface PluginThemeDefinition {
  backdrop?: {
    effect?: "aurora" | "image" | "video";
    asset?: string;
  };
  tokens?: Record<string, string>;
}

export interface PluginManifestV1 {
  apiVersion: 1;
  author: LocalizedText;
  capabilities: PluginCapability[];
  description: LocalizedText;
  engine: {
    minAppVersion: string;
  };
  id: string;
  manifestVersion: 1;
  name: LocalizedText;
  settings: PluginSettingDefinition[];
  theme: PluginThemeDefinition;
  themeFile?: string;
  version: string;
}

export interface PluginRecord {
  assetUrls: Record<string, string>;
  enabled: boolean;
  error?: string;
  manifest: PluginManifestV1;
  settings: Record<string, boolean | number | string>;
  source: PluginSource;
  status: PluginStatus;
}

export interface PluginSnapshot {
  plugins: PluginRecord[];
}

export interface BuiltinPluginContext {
  getSetting: (id: string) => boolean | number | string | undefined;
  onSettingsChanged: (listener: () => void) => () => void;
  root: HTMLElement;
  setRootAttribute: (name: string, value: string | null) => void;
}

export interface BuiltinPlugin {
  // A plugin may only return its disposer; it cannot expose host capabilities.
  // biome-ignore lint/suspicious/noConfusingVoidType: lifecycle activation may be side-effect-only
  activate: (context: BuiltinPluginContext) => void | (() => void);
  id: string;
  renderBackdrop: (props: { record: PluginRecord }) => ReactNode;
  renderSettings: (props: { record: PluginRecord }) => ReactNode;
}
