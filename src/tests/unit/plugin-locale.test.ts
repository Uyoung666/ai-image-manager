import { describe, expect, it } from "vitest";
import {
  analyzeLocaleCoverage,
  canonicalizePluginSignatureEntries,
  parsePluginManifest,
  parsePluginSignature,
  validateLocaleBundle,
  validateLocalePlaceholders,
} from "@/plugins/manifest";

const CONTROL_CHARACTER_ERROR_PATTERN = /control character/;
const HTML_ERROR_PATTERN = /HTML/;
const LOCALE_VALUE_ERROR_PATTERN = /only objects, arrays, or strings/;
const TARGET_LOCALE_NAME_ERROR_PATTERN = /name.*ja-JP/;

const localeManifest = () => ({
  apiVersion: 3,
  author: { name: "Example Studio" },
  capabilities: ["locale"],
  description: {
    en: "Japanese UI translation.",
    "ja-JP": "日本語 UI 翻訳。",
  },
  engine: { minAppVersion: "2.0.0" },
  id: "com.example.japanese-locale",
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

describe("plugin v3 locale manifest boundary", () => {
  it("parses a locale manifest without introducing theme fields", () => {
    const parsed = parsePluginManifest(localeManifest());

    if (parsed.manifestVersion !== 3) {
      throw new Error("expected a v3 locale manifest");
    }
    expect(parsed.manifestVersion).toBe(3);
    expect(parsed.capabilities).toEqual(["locale"]);
    expect(parsed.locale.tag).toBe("ja-JP");
    expect(parsed.name).toEqual({ en: "Japanese", "ja-JP": "日本語" });
    expect(parsed).not.toHaveProperty("theme");
    expect(parsed).not.toHaveProperty("settings");
  });

  it("requires English and the target locale in metadata", () => {
    const manifest = localeManifest();
    const name = { en: "Japanese" } as Record<string, string>;
    const invalid = { ...manifest, name };
    expect(() => parsePluginManifest(invalid)).toThrow(
      TARGET_LOCALE_NAME_ERROR_PATTERN
    );
  });

  it.each([
    "ja_jp",
    "ja-jp",
    "../ja-JP",
    "ja-JP<script>",
  ])("rejects non-canonical locale tag %s", (tag) => {
    const manifest = localeManifest();
    manifest.locale.tag = tag;
    manifest.locale.mainFile = `locales/${tag}/main.json`;
    manifest.locale.rendererFile = `locales/${tag}/renderer.json`;
    (manifest.name as Record<string, string>)[tag] = "Locale";
    (manifest.description as Record<string, string>)[tag] = "Locale";
    expect(() => parsePluginManifest(manifest)).toThrow();
  });

  it("accepts only safe object, array, and string bundle values", () => {
    expect(
      validateLocaleBundle({
        actions: ["Open", "Close"],
        nested: { count: "Count: {{count}}" },
      })
    ).toEqual({
      actions: ["Open", "Close"],
      nested: { count: "Count: {{count}}" },
    });
    expect(() => validateLocaleBundle({ count: 1 })).toThrow(
      LOCALE_VALUE_ERROR_PATTERN
    );
    expect(() => validateLocaleBundle({ html: "<b>unsafe</b>" })).toThrow(
      HTML_ERROR_PATTERN
    );
    expect(() => validateLocaleBundle({ control: "bad\u0001" })).toThrow(
      CONTROL_CHARACTER_ERROR_PATTERN
    );
  });

  it("reports coverage and placeholder mismatches only when a host catalog is supplied", () => {
    const catalog = {
      close: "Close",
      count: "Count: {{count}}",
      open: "Open",
    } as const;
    const translation = {
      close: "閉じる",
      count: "件数",
      extra: "追加",
    } as const;
    const coverage = analyzeLocaleCoverage(translation, catalog);

    expect(coverage.available).toBe(true);
    expect(coverage.total).toBe(3);
    expect(coverage.translated).toBe(2);
    expect(coverage.missing).toEqual(["open"]);
    expect(coverage.extra).toEqual(["extra"]);
    expect(coverage.placeholderMismatches).toEqual(["count"]);
    expect(analyzeLocaleCoverage(translation).percentage).toBeNull();
    expect(
      validateLocalePlaceholders(catalog, {
        count: "件数: {{count}}",
      })
    ).toEqual([]);
  });

  it("uses path, size, sha256 canonical key ordering for signatures", () => {
    expect(
      canonicalizePluginSignatureEntries([
        { path: "locales/ja-JP/main.json", size: 5, sha256: "ABC" },
        { path: "plugin.json", size: 3, sha256: "DEF" },
      ])
    ).toBe(
      '[{"path":"locales/ja-JP/main.json","size":5,"sha256":"abc"},{"path":"plugin.json","size":3,"sha256":"def"}]'
    );
    expect(
      parsePluginSignature({
        algorithm: "ed25519",
        keyId: "release-1",
        signature:
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
      }).algorithm
    ).toBe("ed25519");
  });
});
