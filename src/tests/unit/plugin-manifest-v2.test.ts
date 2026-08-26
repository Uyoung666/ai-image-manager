import { describe, expect, it } from "vitest";
import {
  compareSemVer,
  normalizePluginManifest,
  parsePluginManifest,
  parsePluginThemeV2,
} from "@/plugins/manifest";
import type { PluginSettingDefinitionV2 } from "@/plugins/types";

function manifest() {
  return {
    apiVersion: 2,
    author: { name: "Example Studio", url: "https://example.test" },
    capabilities: ["theme"],
    description: { en: "A theme", zh: "主题" },
    engine: { minAppVersion: "2.0.0" },
    id: "com.example.theme",
    manifestVersion: 2,
    name: { en: "Example", zh: "示例" },
    settings: [
      {
        defaultValue: "dark",
        id: "mode",
        label: { en: "Mode", zh: "模式" },
        options: [
          { label: { en: "Dark", zh: "深色" }, value: "dark" },
          { label: { en: "Light", zh: "浅色" }, value: "light" },
        ],
        type: "select",
      },
      {
        defaultValue: "#1a2b3c",
        id: "accent",
        label: { en: "Accent", zh: "强调色" },
        type: "color",
      },
      {
        defaultValue: null,
        id: "wallpaper",
        label: { en: "Wallpaper", zh: "壁纸" },
        type: "image",
      },
      {
        defaultValue: 0.5,
        id: "opacity",
        label: { en: "Opacity", zh: "不透明度" },
        max: 1,
        min: 0,
        step: 0.1,
        type: "number",
        visibleWhen: { equals: "dark", setting: "mode" },
      },
    ],
    settingGroups: [
      { id: "appearance", label: { en: "Appearance", zh: "外观" } },
    ],
    themeFile: "theme.json",
    version: "1.0.0-rc.1",
  };
}

function settingDefinitions(): PluginSettingDefinitionV2[] {
  const parsed = parsePluginManifest(manifest());
  if (parsed.manifestVersion !== 2) {
    throw new Error("expected a v2 manifest");
  }
  return parsed.settings;
}

describe("plugin manifest v2 boundary", () => {
  it("normalizes groups, setting order, and visibleWhen aliases", () => {
    const parsed = parsePluginManifest(manifest());
    expect(parsed.manifestVersion).toBe(2);
    if (parsed.manifestVersion !== 2) {
      throw new Error("expected a v2 manifest");
    }
    expect(parsed.settingGroups[0]?.order).toBe(0);
    expect(parsed.settings[0]?.order).toBe(0);
    expect(parsed.settings[3]?.visibleWhen).toEqual({
      equals: "dark",
      setting: "mode",
    });
  });

  it("validates typed theme bindings and local assets", () => {
    const parsed = normalizePluginManifest(manifest(), {
      layers: [
        { color: { setting: "accent" }, id: "base", type: "solid" },
        { asset: { setting: "wallpaper" }, id: "wallpaper", type: "image" },
      ],
      material: { kind: "glass" },
      tokens: { background: { setting: "accent" } },
    });
    expect(parsed.manifestVersion).toBe(2);
    if (parsed.manifestVersion !== 2) {
      throw new Error("expected a v2 manifest");
    }
    expect(parsed.theme?.layers).toHaveLength(2);
  });

  it("rejects unsafe or inconsistent recipes", () => {
    expect(() =>
      parsePluginThemeV2({
        layers: [
          {
            color: "url(https://example.test/x)",
            id: "base",
            type: "solid",
          },
        ],
      })
    ).toThrow();

    const invalid = manifest();
    const assetSetting = invalid.settings[2];
    if (!assetSetting) {
      throw new Error("fixture is missing asset setting");
    }
    assetSetting.defaultValue = "not-null";
    expect(() => parsePluginManifest(invalid)).toThrow();
  });

  it("uses SemVer prerelease precedence", () => {
    expect(compareSemVer("1.0.0-rc.2", "1.0.0-rc.10")).toBe(-1);
    expect(compareSemVer("1.0.0", "1.0.0+build.1")).toBe(0);
    expect(compareSemVer("1.0.0", "1.0.0-rc.1")).toBe(1);
  });

  it("keeps v2 colors strict while retaining v1's legacy color sanitizer", () => {
    expect(() =>
      parsePluginManifest({
        ...manifest(),
        author: { name: { en: "Not localized", zh: "不应本地化" } },
      })
    ).toThrow();

    for (const color of ["#abc", "#abcd", "red", "rgb(1 2 3)"]) {
      expect(() =>
        parsePluginManifest({
          ...manifest(),
          settings: [
            { ...manifest().settings[0] },
            { ...manifest().settings[1], defaultValue: color },
            { ...manifest().settings[2] },
            { ...manifest().settings[3] },
          ],
        })
      ).toThrow();
    }

    const valid = parsePluginManifest({
      ...manifest(),
      settings: [
        { ...manifest().settings[0] },
        { ...manifest().settings[1], defaultValue: "#aabbccdd" },
        { ...manifest().settings[2] },
        { ...manifest().settings[3] },
      ],
    });
    expect(valid.manifestVersion).toBe(2);
  });

  it("accepts layer filters and only allows color token bindings", () => {
    const parsed = parsePluginThemeV2(
      {
        layers: [
          {
            blur: 4,
            brightness: 1.1,
            color: "#112233",
            hueRotate: -12,
            id: "base",
            saturation: 1.2,
            type: "solid",
          },
        ],
        tokens: { foreground: { setting: "accent" } },
      },
      settingDefinitions()
    );
    expect(parsed.layers[0]).toMatchObject({
      hueRotate: -12,
      saturation: 1.2,
    });

    expect(() =>
      parsePluginThemeV2(
        { layers: [], tokens: { foreground: { setting: "mode" } } },
        settingDefinitions()
      )
    ).toThrow();
  });
});
