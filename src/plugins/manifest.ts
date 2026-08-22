import { z } from "zod";
import type {
  LocalizedText,
  PluginManifestV1,
  PluginSettingDefinition,
  PluginThemeDefinition,
} from "./types";

const localizedTextSchema = z.object({
  en: z.string().trim().min(1).max(160),
  zh: z.string().trim().min(1).max(160),
});
const semverSchema = z
  .string()
  .regex(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
  );

const settingOptionSchema = z.object({
  label: localizedTextSchema,
  value: z.string().trim().min(1).max(80),
});

const settingSchema = z.object({
  defaultValue: z.union([z.boolean(), z.number(), z.string().max(500)]),
  description: localizedTextSchema.optional(),
  id: z.string().regex(/^[a-z][a-zA-Z0-9]*(?:[.-][a-zA-Z0-9]+)*$/),
  label: localizedTextSchema,
  max: z.number().finite().optional(),
  min: z.number().finite().optional(),
  options: z.array(settingOptionSchema).max(32).optional(),
  step: z.number().finite().positive().optional(),
  type: z.enum(["boolean", "number", "select", "color", "image", "video"]),
});

const themeSchema = z.object({
  backdrop: z
    .object({
      asset: z.string().max(160).optional(),
      effect: z.enum(["aurora", "image", "video"]).optional(),
    })
    .optional(),
  tokens: z.record(z.string().max(80), z.string().max(256)).optional(),
});

export const pluginManifestSchema = z.object({
  apiVersion: z.literal(1),
  author: localizedTextSchema,
  capabilities: z.array(z.literal("theme")).min(1).max(1),
  description: localizedTextSchema,
  engine: z.object({ minAppVersion: semverSchema }),
  id: z
    .string()
    .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/)
    .max(120),
  manifestVersion: z.literal(1),
  name: localizedTextSchema,
  settings: z.array(settingSchema).max(64),
  theme: themeSchema.default({}),
  themeFile: z.literal("theme.json").optional(),
  version: semverSchema,
});

export const pluginThemeSchema = themeSchema;

export const THEME_TOKEN_MAP: Record<string, string> = {
  background: "--background",
  backgroundSecondary: "--background-secondary",
  borderDefault: "--border-default",
  borderSubtle: "--border-subtle",
  galleryCanvas: "--gallery-canvas",
  foreground: "--foreground",
  foregroundSecondary: "--foreground-secondary",
  sidebar: "--sidebar",
  surface: "--surface",
  surfaceElevated: "--surface-elevated",
  surfaceHover: "--surface-hover",
  workspaceBackground: "--workspace-background",
};

const unsafeThemeValue = /(?:url\s*\(|@import|javascript:|[{}<>;])/i;

function isSafeThemeAsset(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return (
    normalized.startsWith("assets/") &&
    !normalized.includes("\0") &&
    !normalized.split("/").some((part) => part === ".." || part.length === 0)
  );
}

export function sanitizeThemeDefinition(
  theme: PluginThemeDefinition
): PluginThemeDefinition {
  const tokens: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme.tokens ?? {})) {
    if (!THEME_TOKEN_MAP[key] || unsafeThemeValue.test(value)) {
      continue;
    }
    tokens[key] = value.trim();
  }
  const backdropAsset = theme.backdrop?.asset;
  let backdrop: PluginThemeDefinition["backdrop"];
  if (theme.backdrop) {
    backdrop =
      !backdropAsset || isSafeThemeAsset(backdropAsset)
        ? theme.backdrop
        : { effect: theme.backdrop.effect };
  }
  return {
    backdrop,
    tokens,
  };
}

export function parsePluginManifest(value: unknown): PluginManifestV1 {
  return pluginManifestSchema.parse(value) as PluginManifestV1;
}

export function parsePluginTheme(value: unknown): PluginThemeDefinition {
  return sanitizeThemeDefinition(pluginThemeSchema.parse(value));
}

export function getLocalizedText(
  value: LocalizedText,
  language: string
): string {
  return language.toLowerCase().startsWith("zh") ? value.zh : value.en;
}

export function getSettingDefault(
  setting: PluginSettingDefinition
): boolean | number | string {
  return setting.defaultValue;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: schema-driven normalization keeps all setting types in one boundary
export function validatePluginSettings(
  manifest: PluginManifestV1,
  values: Record<string, unknown>
): Record<string, boolean | number | string> {
  const result: Record<string, boolean | number | string> = {};
  for (const definition of manifest.settings) {
    const raw = values[definition.id];
    const fallback = getSettingDefault(definition);
    if (definition.type === "boolean") {
      result[definition.id] =
        typeof raw === "boolean" ? raw : Boolean(fallback);
      continue;
    }
    if (definition.type === "number") {
      const numberValue = typeof raw === "number" ? raw : Number(raw);
      const value = Number.isFinite(numberValue)
        ? numberValue
        : Number(fallback);
      const min = definition.min ?? Number.NEGATIVE_INFINITY;
      const max = definition.max ?? Number.POSITIVE_INFINITY;
      result[definition.id] = Math.min(max, Math.max(min, value));
      continue;
    }
    if (definition.type === "select") {
      const allowed = new Set(
        (definition.options ?? []).map((option) => option.value)
      );
      result[definition.id] =
        typeof raw === "string" && allowed.has(raw) ? raw : String(fallback);
      continue;
    }
    result[definition.id] =
      typeof raw === "string" ? raw.slice(0, 500) : String(fallback);
  }
  return result;
}
