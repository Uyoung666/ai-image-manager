import type { PluginManifestV1 } from "../types";

export const NEBULA_GLASS_PLUGIN_ID = "com.uyoung.theme.nebula-glass";
export const NEBULA_GLASS_RECIPE_VERSION = 3;

const DEPRECATED_SETTING_IDS = [
  "particles",
  "mesh",
  "spotlight",
  "press",
  "edgeFade",
] as const;

const LEGACY_RECIPE_DEFAULTS = {
  backdropBlur: 18,
  blur: 18,
  fluidDepth: 62,
  fluidHue: 210,
  frost: 48,
} as const;

const RECIPE_DEFAULTS = {
  backdropBlur: 0,
  blur: 20,
  fluidDepth: 25,
  fluidHue: 320,
  frost: 7,
} as const;

/**
 * Upgrade values that still match the original visual recipe while preserving
 * every setting the user customized away from those defaults.
 */
export function migrateNebulaGlassSettings(
  settings: Record<string, unknown>
): Record<string, unknown> {
  const migrated = { ...settings };
  for (const id of DEPRECATED_SETTING_IDS) {
    delete migrated[id];
  }
  for (const id of Object.keys(
    LEGACY_RECIPE_DEFAULTS
  ) as (keyof typeof LEGACY_RECIPE_DEFAULTS)[]) {
    if (migrated[id] === LEGACY_RECIPE_DEFAULTS[id]) {
      migrated[id] = RECIPE_DEFAULTS[id];
    }
  }
  return migrated;
}

export const NEBULA_GLASS_MANIFEST: PluginManifestV1 = {
  apiVersion: 1,
  author: { en: "Uyoung", zh: "Uyoung" },
  capabilities: ["theme"],
  description: {
    en: "A photographic nebula of frosted surfaces, light and motion.",
    zh: "以摄影星云、磨砂材质与流动光影构成的玻璃主题。",
  },
  engine: { minAppVersion: "2.0.0" },
  id: NEBULA_GLASS_PLUGIN_ID,
  manifestVersion: 1,
  name: { en: "Nebula Glass", zh: "星云玻璃" },
  settingGroups: [
    { id: "material", label: { en: "Material", zh: "材质" }, order: 0 },
    { id: "backdrop", label: { en: "Backdrop", zh: "背景" }, order: 1 },
    { id: "media", label: { en: "Media", zh: "媒体" }, order: 2 },
  ],
  settings: [
    {
      defaultValue: "mica",
      group: "material",
      id: "mode",
      label: { en: "Material mode", zh: "材质模式" },
      order: 0,
      options: [
        { label: { en: "Mica", zh: "Mica 浮层" }, value: "mica" },
        {
          label: { en: "Compatibility", zh: "兼容模式" },
          value: "compatibility",
        },
      ],
      type: "select",
    },
    {
      defaultValue: "aurora",
      group: "backdrop",
      id: "backdrop",
      label: { en: "Backdrop", zh: "背景" },
      order: 0,
      options: [
        { label: { en: "Aurora fluid", zh: "流动极光" }, value: "aurora" },
        { label: { en: "Image", zh: "图片" }, value: "image" },
        { label: { en: "Video", zh: "视频" }, value: "video" },
      ],
      type: "select",
    },
    {
      defaultValue: 20,
      group: "material",
      id: "blur",
      label: { en: "Glass blur", zh: "玻璃模糊" },
      max: 36,
      min: 0,
      order: 1,
      step: 1,
      type: "number",
      unit: "px",
    },
    {
      defaultValue: 7,
      group: "material",
      id: "frost",
      label: { en: "Frost", zh: "磨砂度" },
      max: 100,
      min: 0,
      order: 2,
      step: 1,
      type: "number",
      unit: "%",
    },
    {
      defaultValue: 50,
      group: "backdrop",
      id: "brightness",
      label: { en: "Backdrop brightness", zh: "背景亮度" },
      max: 100,
      min: 0,
      order: 1,
      step: 1,
      type: "number",
      unit: "%",
    },
    {
      defaultValue: 0,
      group: "backdrop",
      id: "backdropBlur",
      label: { en: "Backdrop blur", zh: "背景模糊" },
      max: 40,
      min: 0,
      order: 2,
      step: 1,
      type: "number",
      unit: "px",
    },
    {
      defaultValue: 320,
      group: "backdrop",
      id: "fluidHue",
      label: { en: "Fluid hue", zh: "流体色相" },
      max: 360,
      min: 0,
      order: 3,
      step: 1,
      type: "number",
      unit: "°",
    },
    {
      defaultValue: 25,
      group: "backdrop",
      id: "fluidDepth",
      label: { en: "Fluid depth", zh: "流体深度" },
      max: 100,
      min: 0,
      order: 4,
      step: 1,
      type: "number",
      unit: "%",
    },
    {
      defaultValue: "",
      group: "media",
      id: "wallpaper",
      label: { en: "Wallpaper", zh: "壁纸" },
      type: "image",
      visibleWhen: { equals: "image", setting: "backdrop" },
    },
    {
      defaultValue: "",
      group: "media",
      id: "wallpaperVideo",
      label: { en: "Wallpaper video", zh: "壁纸视频" },
      type: "video",
      visibleWhen: { equals: "video", setting: "backdrop" },
    },
  ],
  theme: {
    backdrop: { effect: "aurora" },
    tokens: {},
  },
  version: "1.2.0",
};
