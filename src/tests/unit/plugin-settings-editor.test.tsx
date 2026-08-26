import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PluginSettingsEditor } from "@/components/plugins/plugin-settings-editor";
import { parsePluginManifest } from "@/plugins/manifest";
import type { NormalizedPluginManifestV2 } from "@/plugins/types";

function editorManifest(): NormalizedPluginManifestV2 {
  const parsed = parsePluginManifest({
    apiVersion: 2,
    author: { name: "Example Studio" },
    capabilities: ["theme"],
    description: { en: "Settings", zh: "设置" },
    engine: { minAppVersion: "2.0.0" },
    id: "com.example.settings",
    manifestVersion: 2,
    name: { en: "Settings", zh: "设置" },
    settingGroups: [
      { id: "appearance", label: { en: "Appearance", zh: "外观" }, order: 1 },
      { id: "media", label: { en: "Media", zh: "媒体" }, order: 2 },
    ],
    settings: [
      {
        defaultValue: "dark",
        group: "appearance",
        id: "mode",
        label: { en: "Mode", zh: "模式" },
        options: [
          { label: { en: "Dark", zh: "深色" }, value: "dark" },
          { label: { en: "Light", zh: "浅色" }, value: "light" },
        ],
        order: 0,
        type: "select",
      },
      {
        defaultValue: 0.2,
        group: "appearance",
        id: "opacity",
        label: { en: "Opacity", zh: "不透明度" },
        max: 1,
        min: 0,
        order: 1,
        step: 0.1,
        type: "number",
        unit: "%",
        visibleWhen: { equals: "dark", setting: "mode" },
      },
      {
        defaultValue: null,
        group: "media",
        id: "wallpaper",
        label: { en: "Wallpaper", zh: "壁纸" },
        order: 0,
        type: "image",
      },
    ],
    themeFile: "theme.json",
    version: "1.0.0",
  });
  if (parsed.manifestVersion !== 2) {
    throw new Error("expected a v2 manifest");
  }
  return parsed;
}

const labels = {
  chooseImage: "Choose image",
  chooseVideo: "Choose video",
  removeAsset: "Remove",
  replaceAsset: "Replace",
  resetAll: "Reset all",
  resetGroup: "Reset group",
  resetSetting: "Reset setting",
};
const RESET_MODE_PATTERN = /Reset setting: Mode/;

describe("PluginSettingsEditor", () => {
  it("orders groups, renders controls, and applies visibleWhen", () => {
    const onPatch = vi.fn();
    const manifest = editorManifest();
    render(
      <PluginSettingsEditor
        labels={labels}
        language="en"
        onPatch={onPatch}
        record={{
          assetUrls: {},
          manifest,
          settings: { mode: "light", opacity: 0.2, wallpaper: null },
        }}
      />
    );

    expect(
      screen.getByRole("heading", { name: "Appearance" })
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Media" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Mode" })).toBeInTheDocument();
    expect(screen.queryByRole("slider", { name: "Opacity" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Choose image" })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("combobox", { name: "Mode" }));
    fireEvent.click(screen.getByRole("option", { name: "Dark" }));

    expect(onPatch).toHaveBeenCalledWith({ mode: "dark" });
    expect(screen.getByRole("slider", { name: "Opacity" })).toBeInTheDocument();
    expect(screen.getByText("0.2 %")).toBeInTheDocument();
  });

  it("debounces slider patches, flushes on pointerup, and rolls back failures", async () => {
    vi.useFakeTimers();
    const error = new Error("patch failed");
    const onPatch = vi.fn().mockRejectedValue(error);
    const onError = vi.fn();
    const manifest = editorManifest();
    render(
      <PluginSettingsEditor
        labels={labels}
        language="en"
        onError={onError}
        onPatch={onPatch}
        record={{
          assetUrls: {},
          manifest,
          settings: { mode: "dark", opacity: 0.2, wallpaper: null },
        }}
      />
    );

    const slider = screen.getByRole("slider", { name: "Opacity" });
    fireEvent.change(slider, { target: { value: "0.7" } });
    expect(onPatch).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(149);
    });
    expect(onPatch).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(onPatch).toHaveBeenCalledWith({ opacity: 0.7 });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onError).toHaveBeenCalledWith(error);
    expect(screen.getByText("0.2 %")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("forwards asset actions and reset scopes through host callbacks", () => {
    const onPatch = vi.fn();
    const onRemoveAsset = vi.fn();
    const onReset = vi.fn();
    const onSelectAsset = vi.fn();
    const manifest = editorManifest();
    render(
      <PluginSettingsEditor
        labels={labels}
        language="en"
        onPatch={onPatch}
        onRemoveAsset={onRemoveAsset}
        onReset={onReset}
        onSelectAsset={onSelectAsset}
        record={{
          assetUrls: { wallpaper: "plugin://wallpaper" },
          manifest,
          settings: { mode: "dark", opacity: 0.2, wallpaper: "wallpaper" },
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onSelectAsset).toHaveBeenCalledWith("wallpaper");
    expect(onRemoveAsset).toHaveBeenCalledWith("wallpaper");

    fireEvent.click(screen.getByRole("button", { name: "Reset all" }));
    expect(onReset).toHaveBeenCalledWith("all");
    fireEvent.click(screen.getAllByRole("button", { name: "Reset group" })[0]);
    expect(onReset).toHaveBeenCalledWith("group", "appearance");
    fireEvent.click(
      screen.getAllByRole("button", { name: RESET_MODE_PATTERN })[0]
    );
    expect(onReset).toHaveBeenCalledWith("setting", "mode");
  });
});
