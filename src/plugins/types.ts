import type { ReactNode } from "react";

export type PluginSource = "builtin" | "local" | "dev";

export type PluginStatus =
  | "disabled"
  | "active"
  | "incompatible"
  | "invalid"
  | "failed";

export type PluginCapability = "locale" | "theme";

export type PluginSettingType =
  | "boolean"
  | "number"
  | "select"
  | "color"
  | "image"
  | "video";

/** Values that may cross the declarative plugin boundary. */
export type PluginSettingValue = boolean | number | string | null;

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
  group?: string;
  id: string;
  label: LocalizedText;
  max?: number;
  min?: number;
  options?: PluginSettingOption[];
  order?: number;
  step?: number;
  type: PluginSettingType;
  unit?: string;
  visibleWhen?: PluginSettingVisibilityV2;
}

export interface PluginSettingOptionV2 {
  label: LocalizedText;
  value: string;
}

export interface PluginSettingVisibilityV2 {
  equals?: PluginSettingValue;
  in?: PluginSettingValue[];
  notEquals?: PluginSettingValue;
  /** The id of the setting whose value controls this setting. */
  setting: string;
  /** `value` is accepted as a concise alias for `equals` by the parser. */
  value?: PluginSettingValue;
}

export interface PluginSettingDefinitionV2 {
  defaultValue: PluginSettingValue;
  description?: LocalizedText;
  group?: string;
  id: string;
  label: LocalizedText;
  max?: number;
  min?: number;
  options?: PluginSettingOptionV2[];
  order?: number;
  step?: number;
  type: PluginSettingType;
  unit?: string;
  visibleWhen?: PluginSettingVisibilityV2;
}

export interface NormalizedPluginSettingDefinitionV2
  extends Omit<PluginSettingDefinitionV2, "order"> {
  order: number;
}

export interface PluginSettingGroupV2 {
  description?: LocalizedText;
  id: string;
  label: LocalizedText;
  order?: number;
}

export interface NormalizedPluginSettingGroupV2
  extends Omit<PluginSettingGroupV2, "order"> {
  order: number;
}

export interface PluginThemeDefinition {
  backdrop?: {
    effect?: "aurora" | "image" | "video";
    asset?: string;
  };
  tokens?: Record<string, string>;
}

export interface ThemeSettingBinding {
  setting: string;
}
export type ThemeParam<T> = T | ThemeSettingBinding;

export type ThemeMaterialKindV2 =
  | "none"
  | "solid"
  | "glass"
  | "mica"
  | "acrylic";

export interface ThemeMaterialV2 {
  blur?: ThemeParam<number>;
  brightness?: ThemeParam<number>;
  color?: ThemeParam<string>;
  hueRotate?: ThemeParam<number>;
  kind: ThemeMaterialKindV2;
  noise?: ThemeParam<number>;
  opacity?: ThemeParam<number>;
  saturation?: ThemeParam<number>;
}

export interface ThemeGradientStopV2 {
  color: ThemeParam<string>;
  offset: ThemeParam<number>;
}

export interface ThemeLayerBaseV2 {
  blendMode?:
    | "normal"
    | "multiply"
    | "screen"
    | "overlay"
    | "soft-light"
    | "hard-light";
  blur?: ThemeParam<number>;
  brightness?: ThemeParam<number>;
  hueRotate?: ThemeParam<number>;
  id: string;
  opacity?: ThemeParam<number>;
  saturation?: ThemeParam<number>;
}

export interface ThemeSolidLayerV2 extends ThemeLayerBaseV2 {
  color: ThemeParam<string>;
  type: "solid";
}

export interface ThemeLinearGradientLayerV2 extends ThemeLayerBaseV2 {
  angle?: ThemeParam<number>;
  stops: ThemeGradientStopV2[];
  type: "linearGradient";
}

export interface ThemeRadialGradientLayerV2 extends ThemeLayerBaseV2 {
  center?: {
    x: ThemeParam<number>;
    y: ThemeParam<number>;
  };
  stops: ThemeGradientStopV2[];
  type: "radialGradient";
}

export interface ThemeImageLayerV2 extends ThemeLayerBaseV2 {
  asset: ThemeParam<string>;
  fit?: "cover" | "contain" | "fill";
  type: "image";
}

export interface ThemeVideoLayerV2 extends ThemeLayerBaseV2 {
  asset: ThemeParam<string>;
  fit?: "cover" | "contain" | "fill";
  type: "video";
}

export interface ThemeAuroraLayerV2 extends ThemeLayerBaseV2 {
  colors?: ThemeParam<string>[];
  intensity?: ThemeParam<number>;
  speed?: ThemeParam<number>;
  type: "aurora";
}

export type ThemeLayerV2 =
  | ThemeSolidLayerV2
  | ThemeLinearGradientLayerV2
  | ThemeRadialGradientLayerV2
  | ThemeImageLayerV2
  | ThemeVideoLayerV2
  | ThemeAuroraLayerV2;

export interface ThemeRecipeV2 {
  layers: ThemeLayerV2[];
  material?: ThemeMaterialV2;
  tokens?: Partial<Record<keyof typeof THEME_TOKEN_KEYS, ThemeParam<string>>>;
}

/** Host token names accepted by v2 theme recipes. */
export const THEME_TOKEN_KEYS = {
  background: true,
  backgroundSecondary: true,
  borderDefault: true,
  borderSubtle: true,
  galleryCanvas: true,
  foreground: true,
  foregroundSecondary: true,
  sidebar: true,
  surface: true,
  surfaceElevated: true,
  surfaceHover: true,
  workspaceBackground: true,
} as const;

export interface PluginAuthorV2 {
  name: string;
  url?: string;
}

export interface PluginManifestV2 {
  apiVersion: 2;
  author: PluginAuthorV2;
  capabilities: ["theme"];
  description: LocalizedText;
  engine: {
    minAppVersion: string;
  };
  homepage?: string;
  icon?: string;
  id: string;
  license?: string;
  manifestVersion: 2;
  name: LocalizedText;
  settingGroups: PluginSettingGroupV2[];
  settings: PluginSettingDefinitionV2[];
  theme?: ThemeRecipeV2;
  themeFile: "theme.json";
  version: string;
}

/** A JSON value accepted by the declarative locale package boundary. */
export type LocaleBundleValue =
  | string
  | LocaleBundleObject
  | LocaleBundleValue[];

export interface LocaleBundleObject {
  [key: string]: LocaleBundleValue;
}

export interface LocaleCoverage {
  available: boolean;
  extra: string[];
  missing: string[];
  percentage: number | null;
  placeholderMismatches: string[];
  total: number;
  translated: number;
}

/**
 * Host-verified metadata exposed on a locale plugin record.
 *
 * This intentionally contains no package or filesystem paths. The locale
 * definition remains on the manifest; this field only reports the result of
 * the host validation boundary to renderer consumers.
 */
export interface PluginRecordLocaleMetadata {
  catalogVersion?: string;
  coverage: LocaleCoverage;
  nativeName?: string;
  signed: boolean;
  signerKeyId?: string;
  tag?: string;
  trust: "developer" | "trusted";
}

export interface PluginLocaleDefinition {
  catalogVersion: string;
  direction: "ltr";
  fallback: "en";
  mainFile: string;
  nativeName: string;
  rendererFile: string;
  tag: string;
}

/** Locale-specific metadata text. Keys are canonical BCP 47 tags. */
export type LocaleTextMap = Record<string, string>;
export type LocalizedTextV3 = LocaleTextMap;

/** The raw v3 manifest shape for a declarative locale package. */
export interface PluginManifestV3Locale {
  apiVersion: 3;
  author: PluginAuthorV2;
  capabilities: ["locale"];
  description: LocaleTextMap;
  engine: {
    minAppVersion: string;
  };
  homepage?: string;
  id: string;
  license?: string;
  locale: PluginLocaleDefinition;
  manifestVersion: 3;
  name: LocaleTextMap;
  version: string;
}

/** Locale manifests do not expose theme/settings fields. */
export type NormalizedPluginManifestV3Locale = PluginManifestV3Locale;

export type PluginSignatureAlgorithm = "ed25519";

export interface PluginSignature {
  algorithm: PluginSignatureAlgorithm;
  keyId: string;
  signature: string;
}

export interface NormalizedPluginManifestV2
  extends Omit<PluginManifestV2, "settings" | "settingGroups" | "theme"> {
  settingGroups: NormalizedPluginSettingGroupV2[];
  settings: NormalizedPluginSettingDefinitionV2[];
  theme?: ThemeRecipeV2;
}

export type PluginManifest =
  | PluginManifestV1
  | PluginManifestV2
  | PluginManifestV3Locale;
export type NormalizedPluginManifest =
  | PluginManifestV1
  | NormalizedPluginManifestV2
  | NormalizedPluginManifestV3Locale;

export type PluginRecordSettings<M extends NormalizedPluginManifest> =
  M extends NormalizedPluginManifestV2
    ? Record<string, PluginSettingValue>
    : M extends NormalizedPluginManifestV3Locale
      ? Record<string, PluginSettingValue>
      : Record<string, boolean | number | string>;

export interface PluginManifestV1 {
  apiVersion: 1;
  author: LocalizedText;
  capabilities: ["theme"];
  description: LocalizedText;
  engine: {
    minAppVersion: string;
  };
  id: string;
  manifestVersion: 1;
  name: LocalizedText;
  settingGroups?: PluginSettingGroupV2[];
  settings: PluginSettingDefinition[];
  theme: PluginThemeDefinition;
  themeFile?: string;
  version: string;
}

export interface PluginRecord<
  M extends NormalizedPluginManifest = PluginManifestV1,
> {
  assetUrls: Record<string, string>;
  enabled: boolean;
  error?: string;
  locale?: PluginRecordLocaleMetadata;
  manifest: M;
  settings: PluginRecordSettings<M>;
  source: PluginSource;
  status: PluginStatus;
}

export interface PluginSnapshot<
  M extends NormalizedPluginManifest = PluginManifestV1,
> {
  plugins: PluginRecord<M>[];
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
}
