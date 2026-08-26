/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { plugins } from "@/ipc/plugins";
import {
  validatePluginAssetInput,
  validatePluginPatch,
} from "@/services/plugin-manager";

describe("plugin IPC v2 contract", () => {
  it("exposes the staged install, asset, reset and developer endpoints", () => {
    expect(Object.keys(plugins)).toEqual(
      expect.arrayContaining([
        "inspectFromDialog",
        "commitInstall",
        "discardInspection",
        "removeAsset",
        "resetSettings",
        "setDeveloperMode",
        "loadDevDirectoryFromDialog",
        "reloadDevPlugin",
        "removeDevPlugin",
      ])
    );
  });

  it("keeps plugin inputs strict and permits v2 null asset settings", () => {
    expect(
      validatePluginPatch({
        pluginId: "com.example.theme",
        settings: { wallpaper: null },
      })
    ).toEqual({
      pluginId: "com.example.theme",
      settings: { wallpaper: null },
    });
    expect(() =>
      validatePluginPatch({
        extra: true,
        pluginId: "com.example.theme",
        settings: {},
      })
    ).toThrow();
    expect(
      validatePluginAssetInput({
        pluginId: "com.example.theme",
        settingId: "wallpaper",
      })
    ).toEqual({
      pluginId: "com.example.theme",
      settingId: "wallpaper",
    });
  });
});
