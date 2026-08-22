import { describe, expect, it } from "vitest";
import { NebulaGlassPlugin } from "@/plugins/builtins/nebula-glass";
import {
  migrateNebulaGlassSettings,
  NEBULA_GLASS_MANIFEST,
  NEBULA_GLASS_PLUGIN_ID,
} from "@/plugins/builtins/nebula-glass-manifest";
import {
  parsePluginManifest,
  parsePluginTheme,
  validatePluginSettings,
} from "@/plugins/manifest";

describe("plugin manifest boundary", () => {
  it("defaults the declarative theme when plugin.json omits it", () => {
    const { theme, ...withoutTheme } = NEBULA_GLASS_MANIFEST;
    const parsed = parsePluginManifest(withoutTheme);

    expect(parsed.theme).toEqual({});
    expect(parsed.id).toBe(NEBULA_GLASS_PLUGIN_ID);
    expect(theme).toBeDefined();
  });

  it("keeps only host tokens and safe theme assets", () => {
    const theme = parsePluginTheme({
      backdrop: { asset: "../secret.png", effect: "image" },
      tokens: {
        background: "hsl(220 20% 10%)",
        foreground: "url(https://example.com/steal.css)",
        unknown: "red",
      },
    });

    expect(theme.backdrop).toEqual({ effect: "image" });
    expect(theme.tokens).toEqual({ background: "hsl(220 20% 10%)" });
  });

  it("normalizes settings to their declared types and ranges", () => {
    const values = validatePluginSettings(NEBULA_GLASS_MANIFEST, {
      backdrop: "not-allowed",
      brightness: 1000,
      particles: "yes",
      wallpaper: 42,
    });

    expect(values.backdrop).toBe("aurora");
    expect(values.brightness).toBe(100);
    expect(values).not.toHaveProperty("particles");
    expect(values.wallpaper).toBe("");
  });

  it("migrates only unchanged legacy Nebula Glass recipe values", () => {
    const migrated = migrateNebulaGlassSettings({
      backdropBlur: 18,
      blur: 18,
      fluidDepth: 62,
      fluidHue: 210,
      frost: 31,
      edgeFade: true,
      mesh: true,
      particles: true,
      press: false,
      spotlight: true,
      wallpaper: "custom-wallpaper",
    });

    expect(migrated).toEqual({
      backdropBlur: 0,
      blur: 20,
      fluidDepth: 25,
      fluidHue: 320,
      frost: 31,
      wallpaper: "custom-wallpaper",
    });
  });

  it("keeps the built-in settings focused on visible material controls", () => {
    const ids = NEBULA_GLASS_MANIFEST.settings.map((setting) => setting.id);

    expect(ids).toEqual([
      "mode",
      "backdrop",
      "blur",
      "frost",
      "brightness",
      "backdropBlur",
      "fluidHue",
      "fluidDepth",
      "wallpaper",
      "wallpaperVideo",
    ]);
  });

  it("returns a disposer that removes built-in root attributes", () => {
    const root = document.documentElement;
    const dispose = NebulaGlassPlugin.activate({
      getSetting: () => undefined,
      onSettingsChanged: () => () => undefined,
      root,
      setRootAttribute: (name, value) => {
        if (value === null) {
          root.removeAttribute(name);
        } else {
          root.setAttribute(name, value);
        }
      },
    });

    expect(root.dataset.nebulaGlass).toBe("active");
    if (typeof dispose === "function") {
      dispose();
    }
    expect(root.dataset.nebulaGlass).toBeUndefined();
  });
});
