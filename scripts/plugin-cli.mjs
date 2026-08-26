#!/usr/bin/env node

/**
 * Developer tooling for public AI Image Manager v2 plugins.
 *
 * The runtime is deliberately not imported here.  Keeping this boundary
 * dependency-free (apart from the repository's existing ZIP packages) makes
 * the CLI useful before the Electron application is built and prevents a
 * plugin author from accidentally depending on renderer-only code.
 */

import { createWriteStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ZipArchive } from "archiver";
import yauzl from "yauzl";

const MANIFEST_FILE = "plugin.json";
const THEME_FILE = "theme.json";
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 256;
const EPOCH = new Date(0);
const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const SETTING_ID_PATTERN = /^[a-z][a-zA-Z0-9]*(?:[.-][a-zA-Z0-9]+)*$/;
const GROUP_ID_PATTERN = /^[a-z][a-zA-Z0-9]*(?:[.-][a-zA-Z0-9]+)*$/;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const ASSET_PATTERN =
  /^assets\/(?!\.)(?!.*\/\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0]+$/;
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:/;
const UNIT_PATTERN = /^[a-zA-Z%°µ/_-]+$/;
// v2 intentionally accepts only deterministic CSS color literals. Keeping this
// allow-list narrow avoids URLs/functions and browser-dependent color parsing at
// the declarative theme boundary.
const SAFE_COLOR_PATTERN = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i;
const ASSET_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".jpeg",
  ".jpg",
  ".mp4",
  ".png",
  ".webm",
  ".webp",
]);
const IMAGE_ASSET_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
]);
const VIDEO_ASSET_EXTENSIONS = new Set([".mp4", ".webm"]);
const SETTING_TYPES = new Set([
  "boolean",
  "number",
  "select",
  "color",
  "image",
  "video",
]);
const LAYER_TYPES = new Set([
  "solid",
  "linearGradient",
  "radialGradient",
  "image",
  "video",
  "aurora",
]);
const SAFE_STYLE_VALUE = /(?:url\s*\(|@import|javascript\s*:|<|>|;|\0)/i;
const HOST_TOKEN_KEYS = new Set([
  "background",
  "backgroundSecondary",
  "borderDefault",
  "borderSubtle",
  "galleryCanvas",
  "foreground",
  "foregroundSecondary",
  "sidebar",
  "surface",
  "surfaceElevated",
  "surfaceHover",
  "workspaceBackground",
]);
const LAYER_BLEND_MODES = new Set([
  "normal",
  "multiply",
  "screen",
  "overlay",
  "soft-light",
  "hard-light",
]);

function compareNames(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

export class PluginCliError extends Error {
  constructor(message) {
    super(message);
    this.name = "PluginCliError";
  }
}

function fail(message) {
  throw new PluginCliError(message);
}

function isPlainObject(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function assertPlainObject(value, context) {
  if (!isPlainObject(value)) {
    fail(`${context} must be an object`);
  }
}

function assertKeys(value, allowed, context) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail(`${context} contains unsupported field "${key}"`);
    }
  }
}

function assertString(value, context, { min = 1, max = 500 } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    fail(`${context} must be a string with ${min}-${max} characters`);
  }
  if (value.includes("\0")) {
    fail(`${context} contains a NUL byte`);
  }
}

function assertLocalized(value, context) {
  assertPlainObject(value, context);
  assertKeys(value, new Set(["en", "zh"]), context);
  assertString(value.en, `${context}.en`, { max: 160 });
  assertString(value.zh, `${context}.zh`, { max: 160 });
}

function assertSemver(value, context) {
  assertString(value, context, { max: 120 });
  if (!SEMVER_PATTERN.test(value)) {
    fail(`${context} must be a SemVer string (for example 1.0.0)`);
  }
}

function assertFiniteNumber(value, context) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${context} must be a finite number`);
  }
}

function isBinding(value) {
  return isPlainObject(value) && Object.hasOwn(value, "setting");
}

function checkBinding(value, context, settingTypes, expectedType) {
  assertPlainObject(value, context);
  assertKeys(value, new Set(["setting"]), context);
  assertString(value.setting, `${context}.setting`, { max: 120 });
  if (!SETTING_ID_PATTERN.test(value.setting)) {
    fail(`${context}.setting is not a valid setting id`);
  }
  const actualType = settingTypes.get(value.setting);
  if (!actualType) {
    fail(`${context} references unknown setting "${value.setting}"`);
  }
  if (
    expectedType &&
    expectedType !== "any" &&
    actualType !== expectedType &&
    !(
      expectedType === "asset" &&
      (actualType === "image" || actualType === "video")
    )
  ) {
    fail(
      `${context} binding must target ${expectedType}, but "${value.setting}" is ${actualType}`
    );
  }
}

function checkColorLiteral(value, context) {
  assertString(value, context, { max: 80 });
  if (!SAFE_COLOR_PATTERN.test(value.trim()) || SAFE_STYLE_VALUE.test(value)) {
    fail(`${context} must be a safe literal color`);
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: typed theme parameters share one literal/binding boundary
function checkThemeParam(value, context, settingTypes, expectedType, assets) {
  if (isBinding(value)) {
    checkBinding(
      value,
      context,
      settingTypes,
      expectedType === "token" ? "color" : expectedType
    );
    return;
  }
  if (expectedType === "number") {
    assertFiniteNumber(value, context);
    return;
  }
  let maxLength = 256;
  if (expectedType === "color" || expectedType === "token") {
    maxLength = 80;
  } else if (
    expectedType === "image" ||
    expectedType === "video" ||
    expectedType === "asset"
  ) {
    maxLength = 160;
  }
  assertString(value, context, { max: maxLength });
  if (expectedType === "color") {
    checkColorLiteral(value, context);
    return;
  }
  if (
    expectedType === "image" ||
    expectedType === "video" ||
    expectedType === "asset"
  ) {
    if (!(ASSET_PATTERN.test(value) && value.startsWith("assets/"))) {
      fail(`${context} must be a safe local assets/ path`);
    }
    const extension = path.posix.extname(value).toLowerCase();
    if (
      (expectedType === "image" && !IMAGE_ASSET_EXTENSIONS.has(extension)) ||
      (expectedType === "video" && !VIDEO_ASSET_EXTENSIONS.has(extension))
    ) {
      fail(`${context} does not match the ${expectedType} asset type`);
    }
    if (assets && !assets.has(value)) {
      fail(`${context} references missing asset "${value}"`);
    }
    return;
  }
  if (expectedType === "token" && !SAFE_COLOR_PATTERN.test(value.trim())) {
    fail(`${context} must be a safe color token`);
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the condition grammar and type matrix are validated at one boundary
function validateVisibleWhen(value, settingTypes, settingDefinitions, context) {
  assertPlainObject(value, context);
  assertKeys(
    value,
    new Set(["setting", "equals", "notEquals", "in", "value"]),
    context
  );
  assertString(value.setting, `${context}.setting`, { max: 120 });
  const type = settingTypes.get(value.setting);
  if (!type) {
    fail(`${context} references unknown setting "${value.setting}"`);
  }
  const operators = ["equals", "notEquals", "in", "value"].filter((key) =>
    Object.hasOwn(value, key)
  );
  if (operators.length !== 1) {
    fail(`${context} must contain exactly one comparison operator`);
  }
  const operator = operators[0];
  const expectedValues = operator === "in";
  const rawValues = expectedValues ? value[operator] : [value[operator]];
  if (!Array.isArray(rawValues) || (expectedValues && rawValues.length === 0)) {
    fail(`${context}.${operator} must be a non-empty array`);
  }
  if (expectedValues && rawValues.length > 32) {
    fail(`${context}.in must contain at most 32 values`);
  }
  if (
    expectedValues &&
    new Set(rawValues.map((item) => JSON.stringify(item))).size !==
      rawValues.length
  ) {
    fail(`${context}.in values must be unique`);
  }
  const definition = settingDefinitions.get(value.setting);
  for (const [index, raw] of rawValues.entries()) {
    const itemContext = `${context}.${operator}[${index}]`;
    if (type === "boolean") {
      if (typeof raw !== "boolean") {
        fail(`${itemContext} must be boolean`);
      }
    } else if (type === "number") {
      assertFiniteNumber(raw, itemContext);
    } else if (type === "select") {
      if (
        typeof raw !== "string" ||
        !definition.options.some((option) => option.value === raw)
      ) {
        fail(`${itemContext} is not a declared select option`);
      }
    } else if (type === "color") {
      checkColorLiteral(raw, itemContext);
    } else if (raw !== null && typeof raw !== "string") {
      fail(`${itemContext} must be null or a string for ${type} settings`);
    } else if (typeof raw === "string") {
      assertString(raw, itemContext, { min: 0, max: 500 });
    }
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: each setting type has a distinct, explicit safety contract
function validateSetting(setting, index, settingTypes, settingDefinitions) {
  const context = `settings[${index}]`;
  assertPlainObject(setting, context);
  assertKeys(
    setting,
    new Set([
      "id",
      "type",
      "label",
      "description",
      "defaultValue",
      "min",
      "max",
      "step",
      "options",
      "group",
      "visibleWhen",
      "order",
      "unit",
    ]),
    context
  );
  assertString(setting.id, `${context}.id`, { max: 120 });
  if (!SETTING_ID_PATTERN.test(setting.id)) {
    fail(`${context}.id is not a valid setting id`);
  }
  if (settingTypes.has(setting.id)) {
    fail(`duplicate setting id "${setting.id}"`);
  }
  if (typeof setting.type !== "string" || !SETTING_TYPES.has(setting.type)) {
    fail(
      `${context}.type must be one of boolean, number, select, color, image, video`
    );
  }
  assertLocalized(setting.label, `${context}.label`);
  if (Object.hasOwn(setting, "description")) {
    assertLocalized(setting.description, `${context}.description`);
  }
  if (Object.hasOwn(setting, "group")) {
    assertString(setting.group, `${context}.group`, { max: 80 });
    if (!GROUP_ID_PATTERN.test(setting.group)) {
      fail(`${context}.group is not a valid group id`);
    }
  }
  if (
    Object.hasOwn(setting, "order") &&
    (!Number.isInteger(setting.order) ||
      setting.order < 0 ||
      setting.order > 10_000)
  ) {
    fail(`${context}.order must be an integer from 0 to 10000`);
  }
  if (Object.hasOwn(setting, "unit")) {
    assertString(setting.unit, `${context}.unit`, { max: 24 });
    if (!UNIT_PATTERN.test(setting.unit)) {
      fail(`${context}.unit contains unsupported characters`);
    }
  }
  if (setting.type === "number") {
    assertFiniteNumber(setting.defaultValue, `${context}.defaultValue`);
    if (Object.hasOwn(setting, "options")) {
      fail(`${context}.options is not valid for number settings`);
    }
    for (const key of ["min", "max", "step"]) {
      if (Object.hasOwn(setting, key)) {
        assertFiniteNumber(setting[key], `${context}.${key}`);
      }
    }
    if (
      setting.min !== undefined &&
      setting.max !== undefined &&
      setting.min > setting.max
    ) {
      fail(`${context}.min must not be greater than max`);
    }
    if (setting.step !== undefined && setting.step <= 0) {
      fail(`${context}.step must be positive`);
    }
    if (setting.min !== undefined && setting.defaultValue < setting.min) {
      fail(`${context}.defaultValue is below min`);
    }
    if (setting.max !== undefined && setting.defaultValue > setting.max) {
      fail(`${context}.defaultValue is above max`);
    }
    if (
      setting.step !== undefined &&
      setting.min !== undefined &&
      Math.abs(
        (setting.defaultValue - setting.min) / setting.step -
          Math.round((setting.defaultValue - setting.min) / setting.step)
      ) > 1e-8
    ) {
      fail(`${context}.defaultValue must align to step from min`);
    }
  } else if (setting.type === "boolean") {
    if (typeof setting.defaultValue !== "boolean") {
      fail(`${context}.defaultValue must be boolean`);
    }
    if (
      ["min", "max", "step", "options", "unit"].some((key) =>
        Object.hasOwn(setting, key)
      )
    ) {
      fail(`${context} boolean settings cannot declare numeric/select fields`);
    }
  } else if (setting.type === "select") {
    assertString(setting.defaultValue, `${context}.defaultValue`, { max: 500 });
  } else if (setting.type === "color") {
    checkColorLiteral(setting.defaultValue, `${context}.defaultValue`);
  } else if (setting.defaultValue !== null) {
    fail(`${context}.defaultValue must be null for ${setting.type} settings`);
  }
  if (setting.type === "select") {
    if (
      !Array.isArray(setting.options) ||
      setting.options.length === 0 ||
      setting.options.length > 32
    ) {
      fail(`${context}.options must contain 1-32 options`);
    }
    const optionValues = new Set();
    setting.options.forEach((option, optionIndex) => {
      const optionContext = `${context}.options[${optionIndex}]`;
      assertPlainObject(option, optionContext);
      assertKeys(option, new Set(["label", "value"]), optionContext);
      assertLocalized(option.label, `${optionContext}.label`);
      assertString(option.value, `${optionContext}.value`, { max: 80 });
      if (optionValues.has(option.value)) {
        fail(`duplicate select option "${option.value}" in ${context}`);
      }
      optionValues.add(option.value);
    });
    if (!optionValues.has(setting.defaultValue)) {
      fail(`${context}.defaultValue must be one of the declared options`);
    }
    if (
      ["min", "max", "step", "unit"].some((key) => Object.hasOwn(setting, key))
    ) {
      fail(`${context} select settings cannot declare numeric fields`);
    }
  } else if (Object.hasOwn(setting, "options")) {
    fail(`${context}.options is only valid for select settings`);
  }
  if (
    setting.type === "color" &&
    ["min", "max", "step", "options", "unit"].some((key) =>
      Object.hasOwn(setting, key)
    )
  ) {
    fail(`${context} color settings cannot declare numeric/select fields`);
  }
  if (
    (setting.type === "image" || setting.type === "video") &&
    ["min", "max", "step", "options", "unit"].some((key) =>
      Object.hasOwn(setting, key)
    )
  ) {
    fail(`${context} ${setting.type} settings only support asset metadata`);
  }
  settingTypes.set(setting.id, setting.type);
  settingDefinitions.set(setting.id, setting);
}

function validateGroups(groups, settings, context = "settingGroups") {
  if (!Array.isArray(groups) || groups.length > 64) {
    fail(`${context} must contain at most 64 groups`);
  }
  const ids = new Set();
  groups.forEach((group, index) => {
    const groupContext = `${context}[${index}]`;
    assertPlainObject(group, groupContext);
    assertKeys(
      group,
      new Set(["id", "label", "description", "order"]),
      groupContext
    );
    assertString(group.id, `${groupContext}.id`, { max: 80 });
    if (!GROUP_ID_PATTERN.test(group.id) || ids.has(group.id)) {
      fail(`${groupContext}.id is invalid or duplicated`);
    }
    assertLocalized(group.label, `${groupContext}.label`);
    if (Object.hasOwn(group, "description")) {
      assertLocalized(group.description, `${groupContext}.description`);
    }
    if (
      Object.hasOwn(group, "order") &&
      (!Number.isInteger(group.order) ||
        group.order < 0 ||
        group.order > 10_000)
    ) {
      fail(`${groupContext}.order must be an integer from 0 to 10000`);
    }
    ids.add(group.id);
  });
  for (const setting of settings) {
    if (setting.group && !ids.has(setting.group)) {
      fail(
        `setting "${setting.id}" references unknown group "${setting.group}"`
      );
    }
  }
  return ids;
}

function validateThemeStops(stops, context, settingTypes, assets) {
  if (!Array.isArray(stops) || stops.length < 2 || stops.length > 16) {
    fail(`${context} must contain 2-16 stops`);
  }
  let previousLiteral;
  stops.forEach((stop, index) => {
    const stopContext = `${context}[${index}]`;
    assertPlainObject(stop, stopContext);
    assertKeys(stop, new Set(["color", "offset"]), stopContext);
    if (!(Object.hasOwn(stop, "color") && Object.hasOwn(stop, "offset"))) {
      fail(`${stopContext} requires color and offset`);
    }
    checkThemeParam(
      stop.color,
      `${stopContext}.color`,
      settingTypes,
      "color",
      assets
    );
    checkThemeParam(
      stop.offset,
      `${stopContext}.offset`,
      settingTypes,
      "number",
      assets
    );
    if (!isBinding(stop.offset)) {
      if (stop.offset < 0 || stop.offset > 1) {
        fail(`${stopContext}.offset must be between 0 and 1`);
      }
      if (previousLiteral !== undefined && stop.offset <= previousLiteral) {
        fail(`${stopContext}.offset must be strictly increasing`);
      }
      previousLiteral = stop.offset;
    }
  });
  const first = stops[0].offset;
  const last = stops.at(-1).offset;
  if (!isBinding(first) && first !== 0) {
    fail(`${context} must start at offset 0`);
  }
  if (!isBinding(last) && last !== 1) {
    fail(`${context} must end at offset 1`);
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: layer schemas share a single hostile-input boundary
function validateThemeLayer(layer, index, settingTypes, assets, layerIds) {
  const context = `layers[${index}]`;
  assertPlainObject(layer, context);
  if (typeof layer.type !== "string" || !LAYER_TYPES.has(layer.type)) {
    fail(`${context}.type must be a supported declarative layer type`);
  }
  const baseKeys = [
    "id",
    "type",
    "blur",
    "brightness",
    "blendMode",
    "hueRotate",
    "opacity",
    "saturation",
  ];
  const keysByType = {
    solid: ["color"],
    linearGradient: ["angle", "stops"],
    radialGradient: ["center", "stops"],
    image: ["asset", "fit"],
    video: ["asset", "fit"],
    aurora: ["colors", "intensity", "speed"],
  };
  assertKeys(layer, new Set([...baseKeys, ...keysByType[layer.type]]), context);
  assertString(layer.id, `${context}.id`, { max: 120 });
  if (!SETTING_ID_PATTERN.test(layer.id) || layerIds.has(layer.id)) {
    fail(`${context}.id is invalid or duplicated`);
  }
  layerIds.add(layer.id);
  for (const [key, minimum, maximum] of [
    ["blur", 0, undefined],
    ["brightness", 0, 2],
    ["hueRotate", -360, 360],
    ["opacity", 0, 1],
    ["saturation", 0, 2],
  ]) {
    if (Object.hasOwn(layer, key)) {
      checkThemeParam(
        layer[key],
        `${context}.${key}`,
        settingTypes,
        "number",
        assets
      );
      if (
        !isBinding(layer[key]) &&
        ((minimum !== undefined && layer[key] < minimum) ||
          (maximum !== undefined && layer[key] > maximum))
      ) {
        fail(`${context}.${key} is outside its safe range`);
      }
    }
  }
  if (Object.hasOwn(layer, "blendMode")) {
    assertString(layer.blendMode, `${context}.blendMode`, { max: 20 });
    if (!LAYER_BLEND_MODES.has(layer.blendMode)) {
      fail(`${context}.blendMode is unsupported`);
    }
  }
  if (layer.type === "solid") {
    checkThemeParam(
      layer.color,
      `${context}.color`,
      settingTypes,
      "color",
      assets
    );
  } else if (layer.type === "linearGradient") {
    validateThemeStops(layer.stops, `${context}.stops`, settingTypes, assets);
    if (Object.hasOwn(layer, "angle")) {
      checkThemeParam(
        layer.angle,
        `${context}.angle`,
        settingTypes,
        "number",
        assets
      );
    }
  } else if (layer.type === "radialGradient") {
    validateThemeStops(layer.stops, `${context}.stops`, settingTypes, assets);
    if (Object.hasOwn(layer, "center")) {
      assertPlainObject(layer.center, `${context}.center`);
      assertKeys(layer.center, new Set(["x", "y"]), `${context}.center`);
      checkThemeParam(
        layer.center.x,
        `${context}.center.x`,
        settingTypes,
        "number",
        assets
      );
      checkThemeParam(
        layer.center.y,
        `${context}.center.y`,
        settingTypes,
        "number",
        assets
      );
      for (const key of ["x", "y"]) {
        if (
          !isBinding(layer.center[key]) &&
          (layer.center[key] < 0 || layer.center[key] > 1)
        ) {
          fail(`${context}.center.${key} must be between 0 and 1`);
        }
      }
    }
  } else if (layer.type === "image" || layer.type === "video") {
    checkThemeParam(
      layer.asset,
      `${context}.asset`,
      settingTypes,
      layer.type,
      assets
    );
    if (Object.hasOwn(layer, "fit")) {
      assertString(layer.fit, `${context}.fit`, { max: 10 });
      if (!["cover", "contain", "fill"].includes(layer.fit)) {
        fail(`${context}.fit is unsupported`);
      }
    }
  } else {
    if (Object.hasOwn(layer, "colors")) {
      if (
        !Array.isArray(layer.colors) ||
        layer.colors.length < 1 ||
        layer.colors.length > 8
      ) {
        fail(`${context}.colors must contain 1-8 colors`);
      }
      layer.colors.forEach((color, colorIndex) => {
        checkThemeParam(
          color,
          `${context}.colors[${colorIndex}]`,
          settingTypes,
          "color",
          assets
        );
      });
    }
    if (Object.hasOwn(layer, "intensity")) {
      checkThemeParam(
        layer.intensity,
        `${context}.intensity`,
        settingTypes,
        "number",
        assets
      );
      if (
        !isBinding(layer.intensity) &&
        (layer.intensity < 0 || layer.intensity > 1)
      ) {
        fail(`${context}.intensity must be between 0 and 1`);
      }
    }
    if (Object.hasOwn(layer, "speed")) {
      checkThemeParam(
        layer.speed,
        `${context}.speed`,
        settingTypes,
        "number",
        assets
      );
      if (!isBinding(layer.speed) && layer.speed < 0) {
        fail(`${context}.speed must not be negative`);
      }
    }
  }
}

function assertHttpUrl(value, context) {
  assertString(value, context, { max: 320 });
  try {
    const url = new URL(value);
    if (
      !(url.protocol === "http:" || url.protocol === "https:") ||
      url.username ||
      url.password
    ) {
      fail(`${context} must be an http(s) URL without credentials`);
    }
  } catch {
    fail(`${context} must be an http(s) URL`);
  }
}

function validateThemeMaterial(material, settingTypes, assets) {
  assertPlainObject(material, `${THEME_FILE}.material`);
  assertKeys(
    material,
    new Set([
      "blur",
      "brightness",
      "color",
      "hueRotate",
      "kind",
      "noise",
      "opacity",
      "saturation",
    ]),
    `${THEME_FILE}.material`
  );
  if (
    typeof material.kind !== "string" ||
    !["none", "solid", "glass", "mica", "acrylic"].includes(material.kind)
  ) {
    fail(`${THEME_FILE}.material.kind is unsupported`);
  }
  for (const [key, minimum, maximum] of [
    ["blur", 0, undefined],
    ["brightness", 0, 2],
    ["hueRotate", -360, 360],
    ["noise", 0, 1],
    ["opacity", 0, 1],
    ["saturation", 0, 2],
  ]) {
    if (Object.hasOwn(material, key)) {
      checkThemeParam(
        material[key],
        `${THEME_FILE}.material.${key}`,
        settingTypes,
        "number",
        assets
      );
      if (
        !isBinding(material[key]) &&
        ((minimum !== undefined && material[key] < minimum) ||
          (maximum !== undefined && material[key] > maximum))
      ) {
        fail(`${THEME_FILE}.material.${key} is outside its safe range`);
      }
    }
  }
  if (Object.hasOwn(material, "color")) {
    checkThemeParam(
      material.color,
      `${THEME_FILE}.material.color`,
      settingTypes,
      "color",
      assets
    );
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: manifest and theme validation form one security boundary
export function validateManifest(manifest, theme, assets = new Set()) {
  assertPlainObject(manifest, MANIFEST_FILE);
  assertKeys(
    manifest,
    new Set([
      "manifestVersion",
      "apiVersion",
      "id",
      "version",
      "name",
      "description",
      "author",
      "engine",
      "capabilities",
      "themeFile",
      "settings",
      "settingGroups",
      "homepage",
      "icon",
      "license",
    ]),
    MANIFEST_FILE
  );
  if (manifest.manifestVersion !== 2 || manifest.apiVersion !== 2) {
    fail(`${MANIFEST_FILE} manifestVersion and apiVersion must both be 2`);
  }
  assertString(manifest.id, `${MANIFEST_FILE}.id`, { max: 120 });
  if (!ID_PATTERN.test(manifest.id)) {
    fail(
      `${MANIFEST_FILE}.id must be a reverse-domain id such as com.example.theme`
    );
  }
  assertSemver(manifest.version, `${MANIFEST_FILE}.version`);
  assertLocalized(manifest.name, `${MANIFEST_FILE}.name`);
  assertLocalized(manifest.description, `${MANIFEST_FILE}.description`);
  assertPlainObject(manifest.author, `${MANIFEST_FILE}.author`);
  assertKeys(
    manifest.author,
    new Set(["name", "url"]),
    `${MANIFEST_FILE}.author`
  );
  assertString(manifest.author.name, `${MANIFEST_FILE}.author.name`, {
    max: 120,
  });
  if (Object.hasOwn(manifest.author, "url")) {
    assertHttpUrl(manifest.author.url, `${MANIFEST_FILE}.author.url`);
  }
  assertPlainObject(manifest.engine, `${MANIFEST_FILE}.engine`);
  assertKeys(
    manifest.engine,
    new Set(["minAppVersion"]),
    `${MANIFEST_FILE}.engine`
  );
  assertSemver(
    manifest.engine.minAppVersion,
    `${MANIFEST_FILE}.engine.minAppVersion`
  );
  if (
    !Array.isArray(manifest.capabilities) ||
    manifest.capabilities.length !== 1 ||
    manifest.capabilities[0] !== "theme"
  ) {
    fail(`${MANIFEST_FILE}.capabilities must be exactly ["theme"]`);
  }
  if (manifest.themeFile !== THEME_FILE) {
    fail(`${MANIFEST_FILE}.themeFile must be "theme.json"`);
  }
  if (Object.hasOwn(manifest, "homepage")) {
    assertHttpUrl(manifest.homepage, `${MANIFEST_FILE}.homepage`);
  }
  if (Object.hasOwn(manifest, "license")) {
    assertString(manifest.license, `${MANIFEST_FILE}.license`, { max: 80 });
  }
  if (Object.hasOwn(manifest, "icon")) {
    checkThemeParam(
      manifest.icon,
      `${MANIFEST_FILE}.icon`,
      new Map(),
      "asset",
      assets
    );
  }
  if (!Array.isArray(manifest.settings) || manifest.settings.length > 64) {
    fail(`${MANIFEST_FILE}.settings must contain at most 64 settings`);
  }
  const settingTypes = new Map();
  const settingDefinitions = new Map();
  manifest.settings.forEach((setting, index) => {
    validateSetting(setting, index, settingTypes, settingDefinitions);
  });
  validateGroups(manifest.settingGroups, manifest.settings);
  const conditionEdges = new Map();
  for (const [index, setting] of manifest.settings.entries()) {
    if (Object.hasOwn(setting, "visibleWhen")) {
      validateVisibleWhen(
        setting.visibleWhen,
        settingTypes,
        settingDefinitions,
        `settings[${index}].visibleWhen`
      );
      const target = settingDefinitions.get(setting.visibleWhen.setting);
      if (!target) {
        fail(`settings[${index}].visibleWhen references an unknown setting`);
      }
      if (target.id === setting.id) {
        fail(`settings[${index}].visibleWhen cannot reference itself`);
      }
      conditionEdges.set(setting.id, target.id);
    }
  }
  for (const setting of manifest.settings) {
    const seen = new Set();
    let current = setting.id;
    while (conditionEdges.has(current)) {
      if (seen.has(current)) {
        fail(
          `${MANIFEST_FILE} visibleWhen dependencies cannot contain a cycle`
        );
      }
      seen.add(current);
      current = conditionEdges.get(current);
    }
  }
  assertPlainObject(theme, THEME_FILE);
  assertKeys(theme, new Set(["layers", "material", "tokens"]), THEME_FILE);
  if (!Array.isArray(theme.layers) || theme.layers.length > 4) {
    fail(`${THEME_FILE}.layers must contain 0-4 layers`);
  }
  const layerIds = new Set();
  theme.layers.forEach((layer, index) => {
    validateThemeLayer(layer, index, settingTypes, assets, layerIds);
  });
  if (Object.hasOwn(theme, "material")) {
    validateThemeMaterial(theme.material, settingTypes, assets);
  }
  if (Object.hasOwn(theme, "tokens")) {
    assertPlainObject(theme.tokens, `${THEME_FILE}.tokens`);
    for (const [key, value] of Object.entries(theme.tokens)) {
      if (!HOST_TOKEN_KEYS.has(key)) {
        fail(`${THEME_FILE}.tokens has an unsupported host token "${key}"`);
      }
      checkThemeParam(
        value,
        `${THEME_FILE}.tokens.${key}`,
        settingTypes,
        "token",
        assets
      );
    }
  }
  return {
    id: manifest.id,
    version: manifest.version,
    assets: [...assets].sort(),
  };
}

function normalizeArchiveEntryName(rawName) {
  if (typeof rawName !== "string") {
    fail("archive contains a non-string entry name");
  }
  const normalized = rawName.replaceAll("\\", "/");
  const directory = normalized.endsWith("/");
  const name = directory ? normalized.slice(0, -1) : normalized;
  if (
    !name ||
    name.startsWith("/") ||
    WINDOWS_DRIVE_PATTERN.test(name) ||
    name.includes("\0") ||
    name.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(`archive contains an unsafe path "${rawName}"`);
  }
  return { directory, name };
}

function assertAllowedEntry(name, directory) {
  if (directory) {
    if (name !== "assets" && !name.startsWith("assets/")) {
      fail(`archive contains an unsupported directory "${name}"`);
    }
    return;
  }
  if (name === MANIFEST_FILE || name === THEME_FILE) {
    return;
  }
  if (!name.startsWith("assets/")) {
    fail(`archive contains an extra file "${name}"`);
  }
  const extension = path.posix.extname(name).toLowerCase();
  if (!ASSET_EXTENSIONS.has(extension)) {
    fail(`archive contains an unsupported asset "${name}"`);
  }
}

function isSymlinkEntry(entry) {
  // ZIP external attributes store Unix mode in the high word.  A symlink is
  // 0120000; this is the same check used by the host installer.
  // biome-ignore lint/suspicious/noBitwiseOperators: ZIP external attributes are bit fields by specification
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xff_ff;
  // biome-ignore lint/suspicious/noBitwiseOperators: ZIP external attributes are bit fields by specification
  return (unixMode & 0xf0_00) === 0xa0_00;
}

function readZipEntry(zipFile, entry, maxBytes) {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new PluginCliError("cannot read archive entry"));
        return;
      }
      const chunks = [];
      let size = 0;
      stream.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          stream.destroy(
            new PluginCliError("archive entry exceeds the size limit")
          );
          return;
        }
        chunks.push(chunk);
      });
      stream.once("error", reject);
      stream.once("end", () => resolve(Buffer.concat(chunks)));
    });
  });
}

async function readArchiveEntries(archivePath) {
  const stat = await fsp.stat(archivePath);
  if (!stat.isFile()) {
    fail("plugin package path is not a file");
  }
  if (stat.size > MAX_ARCHIVE_BYTES) {
    fail("plugin package exceeds the archive size limit");
  }
  return new Promise((resolve, reject) => {
    yauzl.open(
      archivePath,
      { lazyEntries: true, autoClose: true },
      (error, zipFile) => {
        if (error || !zipFile) {
          reject(
            new PluginCliError(
              `cannot read plugin package: ${error?.message ?? "invalid ZIP"}`
            )
          );
          return;
        }
        const entries = new Map();
        let totalBytes = 0;
        let count = 0;
        let settled = false;
        const failArchive = (reason) => {
          if (settled) {
            return;
          }
          settled = true;
          zipFile.close();
          reject(
            reason instanceof Error
              ? reason
              : new PluginCliError(String(reason))
          );
        };
        zipFile.once("error", failArchive);
        zipFile.once("end", () => {
          if (!settled) {
            settled = true;
            resolve([...entries.values()]);
          }
        });
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: archive validation must reject every unsafe entry before reading it
        zipFile.on("entry", (entry) => {
          if (settled) {
            return;
          }
          count += 1;
          if (count > MAX_ARCHIVE_ENTRIES) {
            failArchive(
              new PluginCliError("plugin package contains too many entries")
            );
            return;
          }
          let normalized;
          try {
            normalized = normalizeArchiveEntryName(entry.fileName);
            assertAllowedEntry(normalized.name, normalized.directory);
            if (isSymlinkEntry(entry) || entry.isEncrypted()) {
              failArchive(
                new PluginCliError(
                  "plugin package cannot contain symlinks or encrypted entries"
                )
              );
              return;
            }
            const key = normalized.name.toLowerCase();
            if (entries.has(key)) {
              failArchive(
                new PluginCliError(
                  `plugin package contains duplicate entry "${normalized.name}"`
                )
              );
              return;
            }
            if (normalized.directory) {
              entries.set(key, {
                name: normalized.name,
                directory: true,
                data: null,
              });
              zipFile.readEntry();
              return;
            }
            const maxBytes =
              normalized.name === MANIFEST_FILE ||
              normalized.name === THEME_FILE
                ? MAX_JSON_BYTES
                : MAX_ASSET_BYTES;
            if (
              entry.uncompressedSize > maxBytes ||
              totalBytes + entry.uncompressedSize > MAX_TOTAL_BYTES
            ) {
              failArchive(
                new PluginCliError(
                  "plugin package exceeds the extracted size limit"
                )
              );
              return;
            }
            totalBytes += entry.uncompressedSize;
            readZipEntry(zipFile, entry, maxBytes).then((data) => {
              if (settled) {
                return;
              }
              entries.set(key, {
                name: normalized.name,
                directory: false,
                data,
              });
              zipFile.readEntry();
            }, failArchive);
          } catch (reason) {
            failArchive(reason);
          }
        });
        zipFile.readEntry();
      }
    );
  });
}

function parseJsonBuffer(buffer, context) {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_JSON_BYTES) {
    fail(`${context} exceeds the JSON size limit`);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    fail(`${context} is not valid UTF-8 JSON`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(
      `${context} is invalid JSON: ${error instanceof Error ? error.message : "parse error"}`
    );
  }
}

function validateEntrySet(entries) {
  const files = new Map(
    entries
      .filter((entry) => !entry.directory)
      .map((entry) => [entry.name, entry.data])
  );
  const assets = new Set(
    [...files.keys()].filter((name) => name.startsWith("assets/"))
  );
  if (!(files.has(MANIFEST_FILE) && files.has(THEME_FILE))) {
    fail("plugin package must contain plugin.json and theme.json");
  }
  const manifest = parseJsonBuffer(files.get(MANIFEST_FILE), MANIFEST_FILE);
  const theme = parseJsonBuffer(files.get(THEME_FILE), THEME_FILE);
  const result = validateManifest(manifest, theme, assets);
  // Directories are not needed in a deterministic package.  They are allowed
  // when validating third-party archives, but never become extra files.
  return { ...result, manifest, theme, files };
}

async function readDirectoryEntries(directory) {
  const root = path.resolve(directory);
  const rootStat = await fsp.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail("plugin source must be a real directory");
  }
  const files = new Map();
  const assets = new Set();
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: source validation mirrors the archive boundary
  async function visit(current, relative = "") {
    const children = await fsp.readdir(current, { withFileTypes: true });
    children.sort((left, right) => compareNames(left.name, right.name));
    for (const child of children) {
      const childRelative = relative ? `${relative}/${child.name}` : child.name;
      const normalized = childRelative.replaceAll("\\", "/");
      const childPath = path.join(current, child.name);
      const stat = await fsp.lstat(childPath);
      if (child.isSymbolicLink() || stat.isSymbolicLink()) {
        fail(`plugin source cannot contain symlinks: ${normalized}`);
      }
      if (stat.isDirectory()) {
        if (normalized !== "assets" && !normalized.startsWith("assets/")) {
          fail(
            `plugin source contains an unsupported directory: ${normalized}`
          );
        }
        await visit(childPath, normalized);
        continue;
      }
      if (!stat.isFile()) {
        fail(`plugin source contains a non-regular file: ${normalized}`);
      }
      assertAllowedEntry(normalized, false);
      const maxBytes =
        normalized === MANIFEST_FILE || normalized === THEME_FILE
          ? MAX_JSON_BYTES
          : MAX_ASSET_BYTES;
      if (stat.size > maxBytes) {
        fail(`${normalized} exceeds the size limit`);
      }
      const key = normalized.toLowerCase();
      if (files.has(key)) {
        fail(`plugin source contains duplicate file: ${normalized}`);
      }
      const data = await fsp.readFile(childPath);
      files.set(key, { name: normalized, data });
      if (normalized.startsWith("assets/")) {
        assets.add(normalized);
      }
    }
  }
  await visit(root);
  const ordered = [...files.values()].sort((left, right) =>
    compareNames(left.name, right.name)
  );
  if (
    !(
      ordered.some((entry) => entry.name === MANIFEST_FILE) &&
      ordered.some((entry) => entry.name === THEME_FILE)
    )
  ) {
    fail("plugin source must contain plugin.json and theme.json");
  }
  const fileMap = new Map(ordered.map((entry) => [entry.name, entry.data]));
  const result = validateManifest(
    parseJsonBuffer(fileMap.get(MANIFEST_FILE), MANIFEST_FILE),
    parseJsonBuffer(fileMap.get(THEME_FILE), THEME_FILE),
    assets
  );
  return {
    ...result,
    manifest: parseJsonBuffer(fileMap.get(MANIFEST_FILE), MANIFEST_FILE),
    theme: parseJsonBuffer(fileMap.get(THEME_FILE), THEME_FILE),
    files: new Map(ordered.map((entry) => [entry.name, entry.data])),
  };
}

export function validatePluginDirectory(directory) {
  return readDirectoryEntries(directory);
}

export async function validatePluginPackage(archivePath) {
  const entries = await readArchiveEntries(path.resolve(archivePath));
  return validateEntrySet(entries);
}

export async function validatePlugin(inputPath) {
  const resolved = path.resolve(inputPath);
  const stat = await fsp.lstat(resolved);
  if (stat.isSymbolicLink()) {
    fail("plugin input cannot be a symlink");
  }
  if (stat.isDirectory()) {
    return validatePluginDirectory(resolved);
  }
  if (stat.isFile() && path.extname(resolved).toLowerCase() === ".aim-plugin") {
    return validatePluginPackage(resolved);
  }
  fail("validate expects a plugin directory or a .aim-plugin file");
}

function outputPathFor(out, id, version) {
  const filename = `${id}-${version}.aim-plugin`;
  if (!out) {
    return path.resolve(process.cwd(), filename);
  }
  const resolved = path.resolve(out);
  if (path.extname(resolved).toLowerCase() === ".aim-plugin") {
    return resolved;
  }
  return path.join(resolved, filename);
}

function appendArchiveEntry(archive, data, name) {
  archive.append(data, {
    name,
    date: EPOCH,
    mode: 0o10_0644,
    comment: "",
  });
}

async function writeDeterministicZip(entries, outputPath) {
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  await new Promise((resolve, reject) => {
    const output = createWriteStream(temporaryPath, { flags: "wx" });
    const archive = new ZipArchive({
      forceUTC: true,
      zlib: { level: 9 },
    });
    let settled = false;
    const rejectOnce = (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    output.on("close", () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    output.on("error", rejectOnce);
    archive.on("error", rejectOnce);
    archive.pipe(output);
    try {
      for (const entry of entries) {
        appendArchiveEntry(archive, entry.data, entry.name);
      }
      archive.finalize();
    } catch (error) {
      rejectOnce(error);
    }
  }).catch(async (error) => {
    await fsp.rm(temporaryPath, { force: true });
    throw error;
  });
  await fsp.rm(outputPath, { force: true });
  await fsp.rename(temporaryPath, outputPath);
}

export async function packPlugin(directory, options = {}) {
  const result = await validatePluginDirectory(directory);
  const orderedNames = [MANIFEST_FILE, THEME_FILE, ...result.files.keys()]
    .filter((name, index, names) => names.indexOf(name) === index)
    .sort((left, right) => {
      const rank = (name) => {
        if (name === MANIFEST_FILE) {
          return 0;
        }
        if (name === THEME_FILE) {
          return 1;
        }
        return 2;
      };
      return rank(left) - rank(right) || compareNames(left, right);
    });
  const entries = orderedNames.map((name) => ({
    name,
    data: result.files.get(name),
  }));
  const outputPath = outputPathFor(options.out, result.id, result.version);
  await writeDeterministicZip(entries, outputPath);
  return { ...result, outputPath, entries: orderedNames };
}

function usage() {
  return [
    "Usage:",
    "  node scripts/plugin-cli.mjs validate <directory|plugin.aim-plugin>",
    "  node scripts/plugin-cli.mjs pack <directory> [--out <directory|plugin.aim-plugin>]",
  ].join("\n");
}

function parsePackArguments(args) {
  if (!args[0] || args[0].startsWith("--")) {
    fail(usage());
  }
  let out;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--out") {
      out = args[index + 1];
      if (!out) {
        fail("--out requires a path");
      }
      index += 1;
    } else if (argument.startsWith("--out=")) {
      out = argument.slice("--out=".length);
      if (!out) {
        fail("--out requires a path");
      }
    } else {
      fail(`unknown option "${argument}"`);
    }
  }
  return { directory: args[0], out };
}

export async function runCli(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") {
    console.log(usage());
    return 0;
  }
  if (command === "validate") {
    if (rest.length !== 1) {
      fail(usage());
    }
    const result = await validatePlugin(rest[0]);
    console.log(`valid plugin ${result.id}@${result.version}`);
    return 0;
  }
  if (command === "pack") {
    const { directory, out } = parsePackArguments(rest);
    const result = await packPlugin(directory, { out });
    console.log(`packed ${result.outputPath}`);
    return 0;
  }
  fail(`unknown command "${command}"\n${usage()}`);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  runCli().catch((error) => {
    console.error(
      `plugin-cli: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  });
}
