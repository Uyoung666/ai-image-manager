import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";

vi.unmock("react-i18next");

import { describe, expect, it } from "vitest";
import { getBuiltinMainCatalog } from "@/localization/catalog";
import i18n from "@/localization/i18n";
import {
  parsePluginManifest,
  validateLocaleBundle as validatePluginLocaleBundle,
} from "@/plugins/manifest";

const PLUGIN_ROOT = path.resolve(
  process.cwd(),
  "external-plugins",
  "japanese-locale"
);
const PLACEHOLDER_PATTERN =
  /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}|\{\s*([A-Za-z0-9_.-]+)\s*\}/g;
const EXPECTED_MAIN_KEYS = [
  "closeWindowQuestion",
  "closeWindowTitle",
  "launchAtStartup",
  "minimizeToTray",
  "quit",
  "showWindow",
  "tooltip",
];

type JsonValue = string | JsonValue[] | { [key: string]: JsonValue };

function nodePath(parent: string, child: string | number): string {
  if (typeof child === "number") {
    return `${parent}[${child}]`;
  }
  return parent === "$" ? child : `${parent}.${child}`;
}

function collectStructure(
  value: unknown,
  currentPath = "$",
  result = new Map<string, string>()
): Map<string, string> {
  if (Array.isArray(value)) {
    result.set(currentPath, `array:${value.length}`);
    value.forEach((item, index) => {
      collectStructure(item, nodePath(currentPath, index), result);
    });
    return result;
  }

  if (value !== null && typeof value === "object") {
    result.set(currentPath, "object");
    for (const [key, child] of Object.entries(value)) {
      collectStructure(child, nodePath(currentPath, key), result);
    }
    return result;
  }

  result.set(currentPath, value === null ? "null" : typeof value);
  return result;
}

function sortedEntries(value: Map<string, string>): [string, string][] {
  return [...value.entries()].sort(([left], [right]) => {
    if (left < right) {
      return -1;
    }
    if (left > right) {
      return 1;
    }
    return 0;
  });
}

function collectStringLeaves(
  value: unknown,
  currentPath = "$",
  result = new Map<string, string>()
): Map<string, string> {
  if (typeof value === "string") {
    result.set(currentPath, value);
    return result;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectStringLeaves(item, nodePath(currentPath, index), result);
    });
    return result;
  }

  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      collectStringLeaves(child, nodePath(currentPath, key), result);
    }
  }

  return result;
}

function interpolationNames(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER_PATTERN)]
    .map((match) => match[1] ?? match[2] ?? "")
    .sort();
}

async function readJson(fileName: string): Promise<unknown> {
  const contents = await fs.readFile(path.join(PLUGIN_ROOT, fileName), "utf8");
  return JSON.parse(contents) as JsonValue;
}

describe("Japanese locale plugin contract", () => {
  it("has the fixed v3 manifest fields and passes the manifest validator", async () => {
    const manifest = await readJson("plugin.json");
    const parsed = parsePluginManifest(manifest);

    expect(parsed).toMatchObject({
      apiVersion: 3,
      author: {
        name: "Uyoung",
        url: "https://github.com/Uyoung666/ai-image-manager",
      },
      capabilities: ["locale"],
      description: {
        en: "Japanese UI translation for AI Image Manager.",
        "ja-JP": "AI Image Manager の日本語 UI 翻訳です。",
      },
      engine: { minAppVersion: "2.1.1" },
      homepage: "https://github.com/Uyoung666/ai-image-manager",
      id: "com.aiimagemanager.japanese-locale",
      license: "MIT",
      locale: {
        catalogVersion: "1.0.0",
        direction: "ltr",
        fallback: "en",
        mainFile: "locales/ja-JP/main.json",
        nativeName: "日本語",
        rendererFile: "locales/ja-JP/renderer.json",
        tag: "ja-JP",
      },
      manifestVersion: 3,
      name: { en: "Japanese", "ja-JP": "日本語" },
      version: "1.0.0",
    });
  });

  it("matches the English renderer catalog structure, keys, leaf types, and array lengths", async () => {
    const renderer = await readJson("locales/ja-JP/renderer.json");
    const english = i18n.getResourceBundle("en", "translation");

    expect(english).toBeDefined();
    expect(sortedEntries(collectStructure(renderer))).toEqual(
      sortedEntries(collectStructure(english))
    );
  });

  it("keeps every renderer interpolation parameter identical to English", async () => {
    const renderer = await readJson("locales/ja-JP/renderer.json");
    const englishLeaves = collectStringLeaves(
      i18n.getResourceBundle("en", "translation")
    );
    const rendererLeaves = collectStringLeaves(renderer);

    expect([...rendererLeaves.keys()].sort()).toEqual(
      [...englishLeaves.keys()].sort()
    );
    for (const [key, englishValue] of englishLeaves) {
      expect(interpolationNames(rendererLeaves.get(key) ?? ""), key).toEqual(
        interpolationNames(englishValue)
      );
    }
  });

  it("covers exactly the seven English built-in main keys with non-empty strings", async () => {
    const main = await readJson("locales/ja-JP/main.json");
    const builtinMain = getBuiltinMainCatalog("en");

    expect(Object.keys(builtinMain).sort()).toEqual(
      [...EXPECTED_MAIN_KEYS].sort()
    );
    expect(Object.keys(main as Record<string, unknown>).sort()).toEqual(
      [...EXPECTED_MAIN_KEYS].sort()
    );
    for (const key of EXPECTED_MAIN_KEYS) {
      const value = (main as Record<string, unknown>)[key];
      expect(typeof value, key).toBe("string");
      expect((value as string).trim().length, key).toBeGreaterThan(0);
    }
  });

  it("passes the locale bundle safety validator for both resources", async () => {
    const renderer = await readJson("locales/ja-JP/renderer.json");
    const main = await readJson("locales/ja-JP/main.json");

    expect(() => validatePluginLocaleBundle(renderer)).not.toThrow();
    expect(() => validatePluginLocaleBundle(main)).not.toThrow();
  });
});
