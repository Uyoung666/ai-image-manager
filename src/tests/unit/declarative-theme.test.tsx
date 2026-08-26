import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyDeclarativeTheme,
  DeclarativeThemeBackdrop,
  resolveThemeAsset,
  resolveThemeParam,
} from "@/plugins/declarative-theme";
import type { ThemeRecipeV2 } from "@/plugins/types";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("declarative plugin theme renderer", () => {
  it("resolves setting params and exact host asset mappings only", () => {
    const settings = { accent: "#112233", wallpaper: "assets/wallpaper.png" };
    const assetUrls = {
      "assets/wallpaper.png": "plugin://wallpaper",
      wallpaper: "https://remote.example/wallpaper.png",
      remote: "//remote.example/wallpaper.png",
    };

    expect(resolveThemeParam({ setting: "accent" }, settings)).toBe("#112233");
    expect(resolveThemeAsset("assets/wallpaper.png", settings, assetUrls)).toBe(
      "plugin://wallpaper"
    );
    expect(
      resolveThemeAsset({ setting: "wallpaper" }, settings, assetUrls)
    ).toBe(undefined);
    expect(
      resolveThemeAsset("assets/missing.png", settings, assetUrls)
    ).toBeUndefined();
    expect(resolveThemeAsset("remote", settings, assetUrls)).toBeUndefined();
  });

  it("applies approved variables and restores the host's previous inline values", () => {
    const root = document.createElement("div");
    root.style.setProperty("--background", "#000000");
    root.style.setProperty("--plugin-theme-material-kind", "old");
    const recipe: ThemeRecipeV2 = {
      layers: [],
      material: {
        blur: { setting: "blur" },
        color: { setting: "accent" },
        kind: "glass",
      },
      tokens: {
        background: "#112233",
        foreground: { setting: "accent" },
      },
    };

    const dispose = applyDeclarativeTheme(root, recipe, {
      accent: "#aabbcc",
      blur: 14,
    });

    expect(root.style.getPropertyValue("--background")).toBe("#112233");
    expect(root.style.getPropertyValue("--foreground")).toBe("#aabbcc");
    expect(root.style.getPropertyValue("--plugin-theme-material-blur")).toBe(
      "14"
    );
    expect(root.style.getPropertyValue("--plugin-theme-material-kind")).toBe(
      "glass"
    );

    dispose();
    expect(root.style.getPropertyValue("--background")).toBe("#000000");
    expect(root.style.getPropertyValue("--foreground")).toBe("");
    expect(root.style.getPropertyValue("--plugin-theme-material-kind")).toBe(
      "old"
    );
  });

  it("renders no more than four safe declarative layers", () => {
    const recipe: ThemeRecipeV2 = {
      layers: [
        { color: "#112233", id: "solid", type: "solid" },
        {
          id: "linear",
          stops: [
            { color: "#112233", offset: 0 },
            { color: "#aabbcc", offset: 1 },
          ],
          type: "linearGradient",
        },
        {
          center: { x: 0.5, y: 0.5 },
          id: "radial",
          stops: [
            { color: "#112233", offset: 0 },
            { color: "#aabbcc", offset: 1 },
          ],
          type: "radialGradient",
        },
        { asset: "assets/image.png", id: "image", type: "image" },
        { colors: ["#112233"], id: "ignored", type: "aurora" },
      ],
    };

    render(
      <DeclarativeThemeBackdrop
        recipe={recipe}
        record={{
          assetUrls: { "assets/image.png": "plugin://image" },
          manifest: {} as never,
          settings: {},
        }}
      />
    );

    expect(document.querySelectorAll("[data-plugin-theme-layer]")).toHaveLength(
      4
    );
    expect(
      document.querySelector('[data-plugin-theme-layer="image"]')
    ).toHaveAttribute("src", "plugin://image");
    expect(
      document.querySelector('[data-plugin-theme-layer="ignored"]')
    ).toBeNull();
  });

  it("renders host-controlled material and noise layers", () => {
    render(
      <DeclarativeThemeBackdrop
        recipe={{
          layers: [
            {
              colors: ["#112233", "#445566"],
              id: "animated-aurora",
              speed: 2,
              type: "aurora",
            },
          ],
          material: {
            blur: { setting: "blur" },
            color: "#11223380",
            kind: "glass",
            noise: 0.5,
            opacity: 0.8,
          },
        }}
        record={{
          assetUrls: {},
          manifest: {} as never,
          settings: { blur: 20 },
        }}
      />
    );

    const material = document.querySelector(
      '[data-plugin-theme-material="glass"]'
    );
    expect(material).toHaveStyle({
      backdropFilter: "blur(20px) brightness(1) saturate(1) hue-rotate(0deg)",
      opacity: "0.8",
    });
    expect(
      document.querySelector('[data-plugin-theme-material-noise="true"]')
    ).toBeInTheDocument();
    expect(
      document.querySelector('[data-plugin-theme-layer="animated-aurora"]')
    ).toHaveStyle({
      animation: "plugin-theme-aurora-drift 12s ease-in-out infinite alternate",
    });
  });

  it("keeps video layers host-controlled and muted", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {
      /* no-op in jsdom */
    });
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {
      /* no-op in jsdom */
    });

    render(
      <DeclarativeThemeBackdrop
        recipe={{
          layers: [
            {
              asset: "assets/video.mp4",
              id: "video",
              type: "video",
            },
          ],
        }}
        record={{
          assetUrls: { "assets/video.mp4": "plugin://video" },
          manifest: {} as never,
          settings: {},
        }}
      />
    );

    const video = document.querySelector("video");
    expect(video).toBeInTheDocument();
    expect(video).toHaveAttribute("src", "plugin://video");
    expect(video).toHaveProperty("muted", true);
    expect(video).toHaveProperty("loop", true);
    expect(video).toHaveProperty("playsInline", true);
    cleanup();
  });
});
