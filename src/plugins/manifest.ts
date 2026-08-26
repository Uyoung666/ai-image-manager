import { z } from "zod";
import type {
  LocalizedText,
  NormalizedPluginManifest,
  NormalizedPluginManifestV2,
  NormalizedPluginSettingDefinitionV2,
  NormalizedPluginSettingGroupV2,
  PluginManifest,
  PluginManifestV1,
  PluginManifestV2,
  PluginSettingDefinition,
  PluginSettingDefinitionV2,
  PluginSettingGroupV2,
  PluginSettingValue,
  PluginSettingVisibilityV2,
  PluginThemeDefinition,
  ThemeRecipeV2,
} from "./types";

/* -------------------------------------------------------------------------- */
/* Shared primitives                                                          */
/* -------------------------------------------------------------------------- */

const LOCALIZED_TEXT_LIMIT = 160;
const SETTING_ID_PATTERN = /^[a-z][a-zA-Z0-9]*(?:[.-][a-zA-Z0-9]+)*$/;
const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const NUMERIC_PRERELEASE_PATTERN = /^\d+$/;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

interface ParsedSemVer {
  build: string[];
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<number | string>;
}

function parseSemVer(value: string): ParsedSemVer | null {
  const match = SEMVER_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const prerelease = (match[4] ?? "").split(".").filter(Boolean);
  return {
    build: (match[5] ?? "").split(".").filter(Boolean),
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: prerelease.map((part) =>
      NUMERIC_PRERELEASE_PATTERN.test(part) ? Number(part) : part
    ),
  };
}

/** Strict SemVer 2.0.0 validation, including leading-zero rules. */
export function isValidSemVer(value: string): boolean {
  return typeof value === "string" && parseSemVer(value) !== null;
}

export const isSemVer = isValidSemVer;

/** Compare SemVer precedence (build metadata is intentionally ignored). */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: SemVer precedence has a deliberately explicit comparison matrix.
export function compareSemVer(left: string, right: string): number {
  const a = parseSemVer(left);
  const b = parseSemVer(right);
  if (!(a && b)) {
    throw new Error("Invalid SemVer value");
  }
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) {
      return a[key] > b[key] ? 1 : -1;
    }
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) {
    return 0;
  }
  if (a.prerelease.length === 0) {
    return 1;
  }
  if (b.prerelease.length === 0) {
    return -1;
  }
  const count = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }
    if (leftPart === rightPart) {
      continue;
    }
    if (typeof leftPart === "number" && typeof rightPart === "string") {
      return -1;
    }
    if (typeof leftPart === "string" && typeof rightPart === "number") {
      return 1;
    }
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

export const compareSemver = compareSemVer;

// Keep the old spelling available to integrations that used the local helper.
export const compareVersions = compareSemVer;

const semverSchema = z
  .string()
  .refine(isValidSemVer, "must be a valid SemVer 2.0.0 value");

export { semverSchema };

const localizedTextSchema = z
  .object({
    en: z.string().trim().min(1).max(LOCALIZED_TEXT_LIMIT),
    zh: z.string().trim().min(1).max(LOCALIZED_TEXT_LIMIT),
  })
  .strict();

const localizedTextV1Schema = z.object({
  en: z.string().trim().min(1).max(LOCALIZED_TEXT_LIMIT),
  zh: z.string().trim().min(1).max(LOCALIZED_TEXT_LIMIT),
});

const settingIdSchema = z.string().trim().regex(SETTING_ID_PATTERN).max(120);

const pluginIdSchema = z.string().trim().regex(PLUGIN_ID_PATTERN).max(120);

const finiteNumberSchema = z.number().finite();

const legacySettingValueSchema = z.union([
  z.boolean(),
  finiteNumberSchema,
  z.string().max(500),
  z.null(),
]);

const legacyVisibleWhenSchema = z.object({
  equals: legacySettingValueSchema.optional(),
  in: z.array(legacySettingValueSchema).min(1).max(32).optional(),
  notEquals: legacySettingValueSchema.optional(),
  setting: z.string().regex(SETTING_ID_PATTERN),
  value: legacySettingValueSchema.optional(),
});

const legacySettingGroupSchema = z.object({
  description: localizedTextV1Schema.optional(),
  id: z.string().regex(SETTING_ID_PATTERN),
  label: localizedTextV1Schema,
  order: z.number().int().min(0).max(10_000).optional(),
});

/* -------------------------------------------------------------------------- */
/* v1 schemas and sanitization                                                */
/* -------------------------------------------------------------------------- */

const settingOptionSchema = z.object({
  label: localizedTextV1Schema,
  value: z.string().trim().min(1).max(80),
});

const settingSchema = z.object({
  defaultValue: z.union([
    z.boolean(),
    z.number().finite(),
    z.string().max(500),
  ]),
  description: localizedTextV1Schema.optional(),
  group: z.string().regex(SETTING_ID_PATTERN).optional(),
  id: z.string().regex(SETTING_ID_PATTERN),
  label: localizedTextV1Schema,
  max: z.number().finite().optional(),
  min: z.number().finite().optional(),
  options: z.array(settingOptionSchema).max(32).optional(),
  order: z.number().int().min(0).max(10_000).optional(),
  step: z.number().finite().positive().optional(),
  type: z.enum(["boolean", "number", "select", "color", "image", "video"]),
  unit: z.string().trim().min(1).max(24).optional(),
  visibleWhen: legacyVisibleWhenSchema.optional(),
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
  author: localizedTextV1Schema,
  capabilities: z.array(z.literal("theme")).min(1).max(1),
  description: localizedTextV1Schema,
  engine: z.object({ minAppVersion: semverSchema }),
  id: pluginIdSchema,
  manifestVersion: z.literal(1),
  name: localizedTextV1Schema,
  settings: z.array(settingSchema).max(64),
  settingGroups: z.array(legacySettingGroupSchema).max(64).optional(),
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

const unsafeThemeValue =
  /(?:url\s*\(|@import|javascript\s*:|expression\s*\(|var\s*\(|[{}<>;])/i;

function isSafeThemeAsset(value: string): boolean {
  const normalized = value.trim().replaceAll("\\", "/");
  return (
    normalized.startsWith("assets/") &&
    !normalized.includes("\0") &&
    !normalized.includes("://") &&
    !normalized.split("/").some((part) => part === ".." || part.length === 0)
  );
}

function sanitizeThemeValue(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || unsafeThemeValue.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/** Remove non-host tokens and unsafe values from the legacy theme shape. */
export function sanitizeThemeDefinition(
  theme: PluginThemeDefinition
): PluginThemeDefinition {
  const tokens: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme.tokens ?? {})) {
    const safeValue = sanitizeThemeValue(value);
    if (!Object.hasOwn(THEME_TOKEN_MAP, key) || safeValue === null) {
      continue;
    }
    tokens[key] = safeValue;
  }
  const backdropAsset = theme.backdrop?.asset;
  let backdrop: PluginThemeDefinition["backdrop"];
  if (theme.backdrop) {
    backdrop =
      !backdropAsset || isSafeThemeAsset(backdropAsset)
        ? {
            ...theme.backdrop,
            asset: backdropAsset?.trim(),
          }
        : { effect: theme.backdrop.effect };
  }
  const sanitized: PluginThemeDefinition = {};
  if (backdrop) {
    sanitized.backdrop = backdrop;
  }
  if (Object.keys(tokens).length > 0) {
    sanitized.tokens = tokens;
  }
  return sanitized;
}

/* -------------------------------------------------------------------------- */
/* v2 schemas                                                                 */
/* -------------------------------------------------------------------------- */

const safeUrlSchema = z
  .string()
  .trim()
  .max(320)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }, "must be an http(s) URL");

const v2SettingOptionSchema = z
  .object({
    label: localizedTextSchema,
    value: z.string().trim().min(1).max(80),
  })
  .strict();

const pluginSettingValueSchema = z.union([
  z.boolean(),
  finiteNumberSchema,
  z.string().trim().max(500),
  z.null(),
]);

const visibleWhenSchema = z
  .object({
    equals: pluginSettingValueSchema.optional(),
    in: z.array(pluginSettingValueSchema).min(1).max(32).optional(),
    notEquals: pluginSettingValueSchema.optional(),
    setting: settingIdSchema,
    value: pluginSettingValueSchema.optional(),
  })
  .strict()
  .superRefine((condition, context) => {
    const operators = [
      condition.equals !== undefined,
      condition.notEquals !== undefined,
      condition.in !== undefined,
      condition.value !== undefined,
    ].filter(Boolean).length;
    if (operators !== 1) {
      context.addIssue({
        code: "custom",
        message: "visibleWhen must contain exactly one comparison",
      });
    }
    if (condition.in) {
      const values = condition.in.map((value) => JSON.stringify(value));
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          message: "visibleWhen.in values must be unique",
        });
      }
    }
  });

const v2SettingSchema = z
  .object({
    defaultValue: pluginSettingValueSchema,
    description: localizedTextSchema.optional(),
    group: settingIdSchema.optional(),
    id: settingIdSchema,
    label: localizedTextSchema,
    max: finiteNumberSchema.optional(),
    min: finiteNumberSchema.optional(),
    options: z.array(v2SettingOptionSchema).max(32).optional(),
    order: z.number().int().min(0).max(10_000).optional(),
    step: finiteNumberSchema.positive().optional(),
    type: z.enum(["boolean", "number", "select", "color", "image", "video"]),
    unit: z
      .string()
      .trim()
      .min(1)
      .max(24)
      .regex(/^[a-zA-Z%°µ/_-]+$/)
      .optional(),
    visibleWhen: visibleWhenSchema.optional(),
  })
  .strict();

const v2SettingGroupSchema = z
  .object({
    description: localizedTextSchema.optional(),
    id: settingIdSchema,
    label: localizedTextSchema,
    order: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();

const safeAssetSchema = z
  .string()
  .trim()
  .max(160)
  .refine(isSafeThemeAsset, "must be a local assets/ path");

const safeHexColorPattern = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i;

function isSafeColor(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length <= 80 &&
    !unsafeThemeValue.test(trimmed) &&
    safeHexColorPattern.test(trimmed)
  );
}

const safeColorSchema = z
  .string()
  .trim()
  .max(80)
  .refine(isSafeColor, "must be a safe literal color");

const settingBindingSchema = z.object({ setting: settingIdSchema }).strict();

const numberParamSchema = z.union([finiteNumberSchema, settingBindingSchema]);
const colorParamSchema = z.union([safeColorSchema, settingBindingSchema]);
const assetParamSchema = z.union([safeAssetSchema, settingBindingSchema]);

const layerBase = {
  blur: numberParamSchema.optional(),
  brightness: numberParamSchema.optional(),
  blendMode: z
    .enum([
      "normal",
      "multiply",
      "screen",
      "overlay",
      "soft-light",
      "hard-light",
    ])
    .optional(),
  hueRotate: numberParamSchema.optional(),
  id: settingIdSchema,
  opacity: numberParamSchema.optional(),
  saturation: numberParamSchema.optional(),
};

const gradientStopSchema = z
  .object({ color: colorParamSchema, offset: numberParamSchema })
  .strict();

const solidLayerSchema = z
  .object({ ...layerBase, color: colorParamSchema, type: z.literal("solid") })
  .strict();

const linearGradientLayerSchema = z
  .object({
    ...layerBase,
    angle: numberParamSchema.optional(),
    stops: z.array(gradientStopSchema).min(2).max(16),
    type: z.literal("linearGradient"),
  })
  .strict();

const radialGradientLayerSchema = z
  .object({
    ...layerBase,
    center: z
      .object({ x: numberParamSchema, y: numberParamSchema })
      .strict()
      .optional(),
    stops: z.array(gradientStopSchema).min(2).max(16),
    type: z.literal("radialGradient"),
  })
  .strict();

const imageLayerSchema = z
  .object({
    ...layerBase,
    asset: assetParamSchema,
    fit: z.enum(["cover", "contain", "fill"]).optional(),
    type: z.literal("image"),
  })
  .strict();

const videoLayerSchema = z
  .object({
    ...layerBase,
    asset: assetParamSchema,
    fit: z.enum(["cover", "contain", "fill"]).optional(),
    type: z.literal("video"),
  })
  .strict();

const auroraLayerSchema = z
  .object({
    ...layerBase,
    colors: z.array(colorParamSchema).min(1).max(8).optional(),
    intensity: numberParamSchema.optional(),
    speed: numberParamSchema.optional(),
    type: z.literal("aurora"),
  })
  .strict();

const themeLayerSchema = z.discriminatedUnion("type", [
  solidLayerSchema,
  linearGradientLayerSchema,
  radialGradientLayerSchema,
  imageLayerSchema,
  videoLayerSchema,
  auroraLayerSchema,
]);

const materialSchema = z
  .object({
    blur: numberParamSchema.optional(),
    brightness: numberParamSchema.optional(),
    color: colorParamSchema.optional(),
    hueRotate: numberParamSchema.optional(),
    kind: z.enum(["none", "solid", "glass", "mica", "acrylic"]),
    noise: numberParamSchema.optional(),
    opacity: numberParamSchema.optional(),
    saturation: numberParamSchema.optional(),
  })
  .strict();

const themeRecipeSchema = z
  .object({
    layers: z.array(themeLayerSchema).max(4),
    material: materialSchema.optional(),
    tokens: z.record(z.string(), colorParamSchema).optional(),
  })
  .strict();

const v2ManifestSchema = z
  .object({
    apiVersion: z.literal(2),
    author: z
      .object({
        name: z.string().trim().min(1).max(120),
        url: safeUrlSchema.optional(),
      })
      .strict(),
    capabilities: z.tuple([z.literal("theme")]),
    description: localizedTextSchema,
    engine: z.object({ minAppVersion: semverSchema }).strict(),
    homepage: safeUrlSchema.optional(),
    icon: safeAssetSchema.optional(),
    id: pluginIdSchema,
    license: z.string().trim().min(1).max(80).optional(),
    manifestVersion: z.literal(2),
    name: localizedTextSchema,
    settings: z.array(v2SettingSchema).max(64),
    settingGroups: z.array(v2SettingGroupSchema).max(64),
    themeFile: z.literal("theme.json"),
    version: semverSchema,
  })
  .strict();

export const pluginManifestV2Schema = v2ManifestSchema;
export const pluginThemeV2Schema = themeRecipeSchema;
export const themeRecipeV2Schema = themeRecipeSchema;

/* -------------------------------------------------------------------------- */
/* v2 cross-field validation and normalization                                */
/* -------------------------------------------------------------------------- */

interface V2Issue {
  code: "custom";
  message: string;
  path: Array<number | string>;
}

function throwV2Issues(issues: V2Issue[]): never {
  throw new z.ZodError(issues);
}

function isBinding(value: unknown): value is { setting: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "setting" in value &&
    typeof (value as { setting?: unknown }).setting === "string"
  );
}

function settingValueKind(type: PluginSettingDefinitionV2["type"]): string {
  if (type === "number") {
    return "number";
  }
  if (type === "boolean") {
    return "boolean";
  }
  if (type === "image") {
    return "image";
  }
  if (type === "video") {
    return "video";
  }
  return type;
}

function valueMatchesSetting(
  value: PluginSettingValue,
  definition: PluginSettingDefinitionV2
): boolean {
  switch (definition.type) {
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "select":
      return (
        typeof value === "string" &&
        (definition.options ?? []).some((option) => option.value === value)
      );
    case "color":
      return typeof value === "string" && isSafeColor(value);
    case "image":
    case "video":
      return value === null || typeof value === "string";
    default:
      return false;
  }
}

function normalizeVisibleWhen(
  condition: PluginSettingVisibilityV2 | undefined
): PluginSettingVisibilityV2 | undefined {
  if (!condition) {
    return undefined;
  }
  if (condition.value !== undefined) {
    const { value: _value, ...rest } = condition;
    return { ...rest, equals: condition.value };
  }
  return { ...condition };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this is the single v2 settings cross-field validation boundary.
function validateSettingDefinitions(
  settings: PluginSettingDefinitionV2[],
  groups: PluginSettingGroupV2[],
  issues: V2Issue[]
): void {
  const groupIds = new Set<string>();
  for (const [index, group] of groups.entries()) {
    if (groupIds.has(group.id)) {
      issues.push({
        code: "custom",
        message: `duplicate setting group id: ${group.id}`,
        path: ["settingGroups", index, "id"],
      });
    }
    groupIds.add(group.id);
  }

  const settingIds = new Set<string>();
  const byId = new Map<string, PluginSettingDefinitionV2>();
  for (const [index, definition] of settings.entries()) {
    if (settingIds.has(definition.id)) {
      issues.push({
        code: "custom",
        message: `duplicate setting id: ${definition.id}`,
        path: ["settings", index, "id"],
      });
    }
    settingIds.add(definition.id);
    byId.set(definition.id, definition);
    if (definition.group && !groupIds.has(definition.group)) {
      issues.push({
        code: "custom",
        message: `setting group does not exist: ${definition.group}`,
        path: ["settings", index, "group"],
      });
    }

    const invalidField = (field: string, message: string) =>
      issues.push({
        code: "custom",
        message,
        path: ["settings", index, field],
      });
    const { defaultValue } = definition;
    if (definition.type === "boolean") {
      if (typeof defaultValue !== "boolean") {
        invalidField(
          "defaultValue",
          "boolean settings require a boolean default"
        );
      }
      if (
        definition.min !== undefined ||
        definition.max !== undefined ||
        definition.step !== undefined ||
        definition.options !== undefined ||
        definition.unit !== undefined
      ) {
        invalidField(
          "type",
          "boolean settings cannot declare numeric/select fields"
        );
      }
    } else if (definition.type === "number") {
      if (typeof defaultValue !== "number" || !Number.isFinite(defaultValue)) {
        invalidField(
          "defaultValue",
          "number settings require a finite number default"
        );
      }
      if (definition.options !== undefined) {
        invalidField("options", "number settings cannot declare options");
      }
      if (
        definition.min !== undefined &&
        definition.max !== undefined &&
        definition.min > definition.max
      ) {
        invalidField("min", "min must not be greater than max");
      }
      if (
        typeof defaultValue === "number" &&
        definition.min !== undefined &&
        defaultValue < definition.min
      ) {
        invalidField("defaultValue", "default is below min");
      }
      if (
        typeof defaultValue === "number" &&
        definition.max !== undefined &&
        defaultValue > definition.max
      ) {
        invalidField("defaultValue", "default is above max");
      }
      if (
        typeof defaultValue === "number" &&
        definition.step !== undefined &&
        definition.min !== undefined &&
        Math.abs(
          (defaultValue - definition.min) / definition.step -
            Math.round((defaultValue - definition.min) / definition.step)
        ) > 1e-8
      ) {
        invalidField("defaultValue", "default must align to step from min");
      }
    } else if (definition.type === "select") {
      const options = definition.options ?? [];
      if (options.length === 0) {
        invalidField("options", "select settings require options");
      }
      const optionIds = new Set<string>();
      for (const [optionIndex, option] of options.entries()) {
        if (optionIds.has(option.value)) {
          issues.push({
            code: "custom",
            message: `duplicate option value: ${option.value}`,
            path: ["settings", index, "options", optionIndex, "value"],
          });
        }
        optionIds.add(option.value);
      }
      if (
        typeof defaultValue !== "string" ||
        !options.some((option) => option.value === defaultValue)
      ) {
        invalidField("defaultValue", "select default must be one of options");
      }
      if (
        definition.min !== undefined ||
        definition.max !== undefined ||
        definition.step !== undefined ||
        definition.unit !== undefined
      ) {
        invalidField("type", "select settings cannot declare numeric fields");
      }
    } else if (definition.type === "color") {
      if (typeof defaultValue !== "string" || !isSafeColor(defaultValue)) {
        invalidField(
          "defaultValue",
          "color settings require a safe color default"
        );
      }
      if (
        definition.min !== undefined ||
        definition.max !== undefined ||
        definition.step !== undefined ||
        definition.options !== undefined ||
        definition.unit !== undefined
      ) {
        invalidField(
          "type",
          "color settings cannot declare numeric/select fields"
        );
      }
    } else {
      if (defaultValue !== null) {
        invalidField(
          "defaultValue",
          `${definition.type} defaults must be null`
        );
      }
      if (
        definition.min !== undefined ||
        definition.max !== undefined ||
        definition.step !== undefined ||
        definition.options !== undefined ||
        definition.unit !== undefined
      ) {
        invalidField(
          "type",
          `${definition.type} settings only support asset metadata`
        );
      }
    }
  }

  // Conditions are checked after all setting ids are collected so forward
  // references work, but self-references and cycles are still rejected.
  const edges = new Map<string, string>();
  for (const [index, definition] of settings.entries()) {
    const condition = definition.visibleWhen;
    if (!condition) {
      continue;
    }
    const target = byId.get(condition.setting);
    if (!target) {
      issues.push({
        code: "custom",
        message: `visibleWhen setting does not exist: ${condition.setting}`,
        path: ["settings", index, "visibleWhen", "setting"],
      });
      continue;
    }
    if (condition.setting === definition.id) {
      issues.push({
        code: "custom",
        message: "a setting cannot depend on itself",
        path: ["settings", index, "visibleWhen", "setting"],
      });
    }
    edges.set(definition.id, condition.setting);
    const comparedValues: PluginSettingValue[] = [];
    if (condition.equals !== undefined) {
      comparedValues.push(condition.equals);
    }
    if (condition.notEquals !== undefined) {
      comparedValues.push(condition.notEquals);
    }
    if (condition.value !== undefined) {
      comparedValues.push(condition.value);
    }
    if (condition.in) {
      comparedValues.push(...condition.in);
    }
    for (const value of comparedValues) {
      if (!valueMatchesSetting(value, target)) {
        issues.push({
          code: "custom",
          message: `visibleWhen value does not match ${target.type} setting`,
          path: ["settings", index, "visibleWhen"],
        });
        break;
      }
    }
  }

  for (const id of settingIds) {
    const seen = new Set<string>();
    let current: string | undefined = id;
    while (current && edges.has(current)) {
      if (seen.has(current)) {
        issues.push({
          code: "custom",
          message: "visibleWhen dependencies cannot contain a cycle",
          path: ["settings"],
        });
        break;
      }
      seen.add(current);
      current = edges.get(current);
    }
  }
}

type ThemeExpectedKind = "any" | "number" | "color" | "image" | "video";

function validateThemeBinding(
  value: unknown,
  expected: ThemeExpectedKind,
  settings: Map<string, PluginSettingDefinitionV2>,
  issues: V2Issue[],
  path: Array<number | string>
): void {
  if (!isBinding(value)) {
    return;
  }
  const definition = settings.get(value.setting);
  if (!definition) {
    issues.push({
      code: "custom",
      message: `theme binding setting does not exist: ${value.setting}`,
      path,
    });
    return;
  }
  const actual = settingValueKind(definition.type);
  if (expected !== "any" && actual !== expected) {
    issues.push({
      code: "custom",
      message: `theme binding requires ${expected} setting, received ${definition.type}`,
      path,
    });
  }
}

function validateThemeNumberLiteral(
  value: unknown,
  issues: V2Issue[],
  path: Array<number | string>,
  minimum?: number,
  maximum?: number
): void {
  if (isBinding(value) || typeof value !== "number") {
    return;
  }
  if (
    !Number.isFinite(value) ||
    (minimum !== undefined && value < minimum) ||
    (maximum !== undefined && value > maximum)
  ) {
    issues.push({
      code: "custom",
      message: "theme numeric parameter is outside its safe range",
      path,
    });
  }
}

function validateThemeColorLiteral(
  value: unknown,
  issues: V2Issue[],
  path: Array<number | string>
): void {
  if (!isBinding(value) && (typeof value !== "string" || !isSafeColor(value))) {
    issues.push({
      code: "custom",
      message: "theme color must be a safe literal color",
      path,
    });
  }
}

function validateGradientStops(
  stops: Array<{ color: unknown; offset: unknown }>,
  settings: Map<string, PluginSettingDefinitionV2>,
  issues: V2Issue[],
  path: Array<number | string>
): void {
  let previousLiteral: number | undefined;
  for (const [index, stop] of stops.entries()) {
    const stopPath = [...path, index];
    validateThemeBinding(stop.offset, "number", settings, issues, [
      ...stopPath,
      "offset",
    ]);
    validateThemeBinding(stop.color, "color", settings, issues, [
      ...stopPath,
      "color",
    ]);
    validateThemeNumberLiteral(
      stop.offset,
      issues,
      [...stopPath, "offset"],
      0,
      1
    );
    validateThemeColorLiteral(stop.color, issues, [...stopPath, "color"]);
    if (typeof stop.offset === "number") {
      if (previousLiteral !== undefined && stop.offset <= previousLiteral) {
        issues.push({
          code: "custom",
          message: "gradient stop offsets must be strictly increasing",
          path: [...stopPath, "offset"],
        });
      }
      previousLiteral = stop.offset;
    }
  }
  const first = stops[0]?.offset;
  const last = stops.at(-1)?.offset;
  if (typeof first === "number" && first !== 0) {
    issues.push({
      code: "custom",
      message: "gradient must start at offset 0",
      path: [...path, 0, "offset"],
    });
  }
  if (typeof last === "number" && last !== 1) {
    issues.push({
      code: "custom",
      message: "gradient must end at offset 1",
      path: [...path, stops.length - 1, "offset"],
    });
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this is the single v2 recipe cross-field validation boundary.
function validateThemeRecipe(
  recipe: ThemeRecipeV2,
  settingDefinitions: PluginSettingDefinitionV2[],
  issues: V2Issue[]
): void {
  const settingMap = new Map(
    settingDefinitions.map((definition) => [definition.id, definition])
  );
  for (const [key, value] of Object.entries(recipe.tokens ?? {})) {
    if (!Object.hasOwn(THEME_TOKEN_MAP, key)) {
      issues.push({
        code: "custom",
        message: `theme token is not host-approved: ${key}`,
        path: ["tokens", key],
      });
    }
    if (isBinding(value)) {
      validateThemeBinding(value, "color", settingMap, issues, ["tokens", key]);
    }
  }
  const material = recipe.material;
  if (material) {
    if (material.blur !== undefined) {
      validateThemeBinding(material.blur, "number", settingMap, issues, [
        "material",
        "blur",
      ]);
      validateThemeNumberLiteral(
        material.blur,
        issues,
        ["material", "blur"],
        0
      );
    }
    for (const key of ["noise", "opacity", "saturation"] as const) {
      const value = material[key];
      if (value === undefined) {
        continue;
      }
      validateThemeBinding(value, "number", settingMap, issues, [
        "material",
        key,
      ]);
      validateThemeNumberLiteral(
        value,
        issues,
        ["material", key],
        0,
        key === "opacity" || key === "noise" ? 1 : undefined
      );
    }
    if (material.brightness !== undefined) {
      validateThemeBinding(material.brightness, "number", settingMap, issues, [
        "material",
        "brightness",
      ]);
      validateThemeNumberLiteral(
        material.brightness,
        issues,
        ["material", "brightness"],
        0,
        2
      );
    }
    if (material.hueRotate !== undefined) {
      validateThemeBinding(material.hueRotate, "number", settingMap, issues, [
        "material",
        "hueRotate",
      ]);
      validateThemeNumberLiteral(
        material.hueRotate,
        issues,
        ["material", "hueRotate"],
        -360,
        360
      );
    }
    if (material.color !== undefined) {
      validateThemeBinding(material.color, "color", settingMap, issues, [
        "material",
        "color",
      ]);
      validateThemeColorLiteral(material.color, issues, ["material", "color"]);
    }
  }

  const layerIds = new Set<string>();
  for (const [index, layer] of recipe.layers.entries()) {
    if (layerIds.has(layer.id)) {
      issues.push({
        code: "custom",
        message: `duplicate theme layer id: ${layer.id}`,
        path: ["layers", index, "id"],
      });
    }
    layerIds.add(layer.id);
    const layerPath: Array<number | string> = ["layers", index];
    if (layer.opacity !== undefined) {
      validateThemeBinding(layer.opacity, "number", settingMap, issues, [
        ...layerPath,
        "opacity",
      ]);
      validateThemeNumberLiteral(
        layer.opacity,
        issues,
        [...layerPath, "opacity"],
        0,
        1
      );
    }
    for (const [key, minimum, maximum] of [
      ["blur", 0, undefined],
      ["brightness", 0, 2],
      ["saturation", 0, 2],
      ["hueRotate", -360, 360],
    ] as const) {
      const value = layer[key];
      if (value === undefined) {
        continue;
      }
      validateThemeBinding(value, "number", settingMap, issues, [
        ...layerPath,
        key,
      ]);
      validateThemeNumberLiteral(
        value,
        issues,
        [...layerPath, key],
        minimum,
        maximum
      );
    }
    if (layer.type === "solid") {
      validateThemeBinding(layer.color, "color", settingMap, issues, [
        ...layerPath,
        "color",
      ]);
      validateThemeColorLiteral(layer.color, issues, [...layerPath, "color"]);
    } else if (
      layer.type === "linearGradient" ||
      layer.type === "radialGradient"
    ) {
      validateGradientStops(layer.stops, settingMap, issues, [
        ...layerPath,
        "stops",
      ]);
      if (layer.type === "linearGradient" && layer.angle !== undefined) {
        validateThemeBinding(layer.angle, "number", settingMap, issues, [
          ...layerPath,
          "angle",
        ]);
        validateThemeNumberLiteral(layer.angle, issues, [
          ...layerPath,
          "angle",
        ]);
      }
      if (layer.type === "radialGradient" && layer.center) {
        for (const key of ["x", "y"] as const) {
          validateThemeBinding(
            layer.center[key],
            "number",
            settingMap,
            issues,
            [...layerPath, "center", key]
          );
          validateThemeNumberLiteral(
            layer.center[key],
            issues,
            [...layerPath, "center", key],
            0,
            1
          );
        }
      }
    } else if (layer.type === "image" || layer.type === "video") {
      validateThemeBinding(layer.asset, layer.type, settingMap, issues, [
        ...layerPath,
        "asset",
      ]);
      if (!(isBinding(layer.asset) || isSafeThemeAsset(layer.asset))) {
        issues.push({
          code: "custom",
          message: "theme media asset must be a local assets/ path",
          path: [...layerPath, "asset"],
        });
      }
    } else if (layer.type === "aurora") {
      if (layer.intensity !== undefined) {
        validateThemeBinding(layer.intensity, "number", settingMap, issues, [
          ...layerPath,
          "intensity",
        ]);
        validateThemeNumberLiteral(
          layer.intensity,
          issues,
          [...layerPath, "intensity"],
          0,
          1
        );
      }
      if (layer.speed !== undefined) {
        validateThemeBinding(layer.speed, "number", settingMap, issues, [
          ...layerPath,
          "speed",
        ]);
        validateThemeNumberLiteral(
          layer.speed,
          issues,
          [...layerPath, "speed"],
          0
        );
      }
      for (const [colorIndex, color] of (layer.colors ?? []).entries()) {
        validateThemeBinding(color, "color", settingMap, issues, [
          ...layerPath,
          "colors",
          colorIndex,
        ]);
        validateThemeColorLiteral(color, issues, [
          ...layerPath,
          "colors",
          colorIndex,
        ]);
      }
    }
  }
}

function normalizeV2Manifest(
  manifest: PluginManifestV2,
  theme?: ThemeRecipeV2
): NormalizedPluginManifestV2 {
  const settings: NormalizedPluginSettingDefinitionV2[] = manifest.settings.map(
    (definition) => ({
      ...definition,
      order: definition.order ?? 0,
      ...(definition.visibleWhen
        ? { visibleWhen: normalizeVisibleWhen(definition.visibleWhen) }
        : {}),
    })
  );
  const settingGroups: NormalizedPluginSettingGroupV2[] =
    manifest.settingGroups.map((group) => ({
      ...group,
      order: group.order ?? 0,
    }));
  return {
    ...manifest,
    settings,
    settingGroups,
    ...(theme ? { theme } : {}),
  };
}

export function parsePluginManifestV1(value: unknown): PluginManifestV1 {
  const parsed = pluginManifestSchema.parse(value) as PluginManifestV1;
  // Sanitize embedded theme values as well as external theme.json values.
  return {
    ...parsed,
    theme: sanitizeThemeDefinition(parsed.theme),
  };
}

export function parsePluginManifestV2(
  value: unknown,
  theme?: unknown
): NormalizedPluginManifestV2 {
  const parsed = v2ManifestSchema.parse(value) as PluginManifestV2;
  const issues: V2Issue[] = [];
  validateSettingDefinitions(parsed.settings, parsed.settingGroups, issues);
  let parsedTheme: ThemeRecipeV2 | undefined;
  if (theme !== undefined) {
    parsedTheme = themeRecipeSchema.parse(theme) as ThemeRecipeV2;
    validateThemeRecipe(parsedTheme, parsed.settings, issues);
  }
  if (issues.length > 0) {
    throwV2Issues(issues);
  }
  return normalizeV2Manifest(parsed, parsedTheme);
}

/** Parse either supported manifest version and return its normalized shape. */
export function parsePluginManifest(value: unknown): NormalizedPluginManifest {
  if (typeof value === "object" && value !== null) {
    const candidate = value as {
      apiVersion?: unknown;
      manifestVersion?: unknown;
    };
    if (candidate.apiVersion === 2 || candidate.manifestVersion === 2) {
      return parsePluginManifestV2(value);
    }
  }
  return parsePluginManifestV1(value);
}

export const parsePluginManifestAny = parsePluginManifest;
export const parseManifest = parsePluginManifest;

/** Normalize a manifest and, when supplied, its external theme.json recipe. */
export function normalizePluginManifest(
  value: unknown,
  theme?: unknown
): NormalizedPluginManifest {
  if (typeof value === "object" && value !== null) {
    const candidate = value as {
      apiVersion?: unknown;
      manifestVersion?: unknown;
    };
    if (candidate.apiVersion === 2 || candidate.manifestVersion === 2) {
      return parsePluginManifestV2(value, theme);
    }
  }
  if (theme !== undefined) {
    throw new z.ZodError([
      {
        code: "custom",
        message: "v1 manifests do not accept a v2 theme recipe",
        path: ["theme"],
      },
    ]);
  }
  return parsePluginManifestV1(value);
}

export const normalizeManifest = normalizePluginManifest;

export function parsePluginTheme(value: unknown): PluginThemeDefinition {
  return sanitizeThemeDefinition(pluginThemeSchema.parse(value));
}

export function parsePluginThemeV2(
  value: unknown,
  settings: PluginSettingDefinitionV2[] = []
): ThemeRecipeV2 {
  const recipe = themeRecipeSchema.parse(value) as ThemeRecipeV2;
  const issues: V2Issue[] = [];
  validateThemeRecipe(recipe, settings, issues);
  if (issues.length > 0) {
    throwV2Issues(issues);
  }
  return recipe;
}

export const parseThemeRecipe = parsePluginThemeV2;

export function getLocalizedText(
  value: LocalizedText,
  language: string
): string {
  return language.toLowerCase().startsWith("zh") ? value.zh : value.en;
}

export function getSettingDefault(
  setting: PluginSettingDefinition
): boolean | number | string;
export function getSettingDefault(
  setting: PluginSettingDefinitionV2
): PluginSettingValue;
export function getSettingDefault(
  setting: PluginSettingDefinition | PluginSettingDefinitionV2
): PluginSettingValue {
  return setting.defaultValue;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy setting coercion preserves v1 behavior.
function normalizePluginSettingsV1(
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: v2 setting coercion handles each declared setting kind explicitly.
function normalizePluginSettingsV2(
  manifest: PluginManifestV2 | NormalizedPluginManifestV2,
  values: Record<string, unknown>
): Record<string, PluginSettingValue> {
  const result: Record<string, PluginSettingValue> = {};
  for (const definition of manifest.settings) {
    const raw = values[definition.id];
    const fallback = definition.defaultValue;
    if (definition.type === "boolean") {
      result[definition.id] =
        typeof raw === "boolean" ? raw : Boolean(fallback);
    } else if (definition.type === "number") {
      const value = typeof raw === "number" ? raw : Number(raw);
      const finite = Number.isFinite(value) ? value : Number(fallback);
      const min = definition.min ?? Number.NEGATIVE_INFINITY;
      const max = definition.max ?? Number.POSITIVE_INFINITY;
      result[definition.id] = Math.min(max, Math.max(min, finite));
    } else if (definition.type === "select") {
      const allowed = new Set(
        (definition.options ?? []).map((option) => option.value)
      );
      result[definition.id] =
        typeof raw === "string" && allowed.has(raw) ? raw : fallback;
    } else if (definition.type === "image" || definition.type === "video") {
      result[definition.id] = typeof raw === "string" ? raw : null;
    } else {
      result[definition.id] =
        typeof raw === "string" && isSafeColor(raw) ? raw : fallback;
    }
  }
  return result;
}

// Preserve the v1 call signature while allowing v2 callers to opt into null
// asset defaults and the stricter color normalization.
export function validatePluginSettings(
  manifest: PluginManifestV1,
  values: Record<string, unknown>
): Record<string, boolean | number | string>;
export function validatePluginSettings(
  manifest: PluginManifestV2 | NormalizedPluginManifestV2,
  values: Record<string, unknown>
): Record<string, PluginSettingValue>;
export function validatePluginSettings(
  manifest: PluginManifest | NormalizedPluginManifestV2,
  values: Record<string, unknown>
): Record<string, PluginSettingValue> {
  return manifest.manifestVersion === 2
    ? normalizePluginSettingsV2(manifest, values)
    : normalizePluginSettingsV1(manifest, values);
}
