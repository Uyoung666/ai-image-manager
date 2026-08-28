/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => new Map<string, string>());
const providers = vi.hoisted(() => ({
  list: [] as unknown[],
  load: vi.fn(),
}));

vi.mock("@/services/settings-manager", () => ({
  deleteSetting: (key: string) => settings.delete(key),
  getSetting: (key: string) => settings.get(key) ?? null,
  setSetting: (key: string, value: string) => settings.set(key, value),
}));

vi.mock("@/localization/plugin-adapter", () => ({
  listVerifiedLocaleProviders: async () => providers.list,
  loadVerifiedLocaleProvider: providers.load,
}));

vi.mock("electron-store", () => ({
  default: class MockElectronStore {
    get() {
      return undefined;
    }
  },
}));

import {
  getMainLocaleText,
  getMainLocalizationState,
  onMainLocaleChanged,
  previewMainLocaleSelection,
  restoreMainLocalePreview,
  revalidateMainLocalization,
  setMainLocaleSelection,
} from "@/localization/main-runtime";

describe("main localization runtime", () => {
  beforeEach(() => {
    settings.clear();
    providers.list = [];
    providers.load.mockReset();
  });

  it("migrates a renderer hint and falls back to built-in main text", async () => {
    const state = await getMainLocalizationState("zh");

    expect(state.selectedLocale).toBe("zh");
    expect(state.providerPluginId).toBeNull();
    expect(settings.get("ui.selectedLocale")).toBe("zh");
    expect(getMainLocaleText("tooltip")).toBe("AI 图片管理器");
  });

  it("loads a verified provider, previews it, and restores without persistence", async () => {
    providers.list = [
      {
        direction: "ltr",
        locale: "ja-JP",
        nativeName: "日本語",
        pluginId: "com.example.japanese",
        version: "1.0.0",
      },
    ];
    providers.load.mockResolvedValue({
      direction: "ltr",
      locale: "ja-JP",
      main: { tooltip: "AI Image Manager JP" },
      nativeName: "日本語",
      providerPluginId: "com.example.japanese",
      renderer: { appName: "AI 画像マネージャー" },
      version: "1.0.0",
    });

    // The first test initializes the module's singleton in the same test file;
    // a built-in selection is still a valid baseline for this flow.
    await setMainLocaleSelection({ locale: "en" });
    const preview = await previewMainLocaleSelection({
      locale: "ja-JP",
      providerPluginId: "com.example.japanese",
    });
    expect(preview.selectedLocale).toBe("ja-JP");
    expect(preview.renderer).toEqual({ appName: "AI 画像マネージャー" });
    expect(getMainLocaleText("tooltip")).toBe("AI Image Manager JP");
    expect(settings.get("ui.selectedLocale")).toBe("en");

    const restored = await restoreMainLocalePreview();
    expect(restored.selectedLocale).toBe("en");
    expect(getMainLocaleText("tooltip")).toBe("AI Image Manager");
  });

  it("falls back and persists when the active provider disappears", async () => {
    providers.list = [
      {
        direction: "ltr",
        locale: "ja-JP",
        nativeName: "日本語",
        pluginId: "com.example.japanese",
        version: "1.0.0",
      },
    ];
    providers.load.mockResolvedValue({
      direction: "ltr",
      locale: "ja-JP",
      main: { tooltip: "AI Image Manager JP" },
      nativeName: "日本語",
      providerPluginId: "com.example.japanese",
      renderer: { appName: "AI 画像マネージャー" },
      version: "1.0.0",
    });

    await setMainLocaleSelection({
      locale: "ja-JP",
      providerPluginId: "com.example.japanese",
    });
    providers.list = [];

    const state = await revalidateMainLocalization();
    expect(state.providerPluginId).toBeNull();
    expect(state.selectedLocale).toBe("zh");
    expect(settings.get("ui.selectedLocale")).toBe("zh");
    expect(settings.get("ui.providerPluginId")).toBe("");
    expect(getMainLocaleText("tooltip")).toBe("AI 图片管理器");
  });

  it("notifies main-process surfaces when a developer locale reloads at the same version", async () => {
    const provider = {
      direction: "ltr",
      locale: "ja-JP",
      nativeName: "日本語",
      pluginId: "com.example.japanese",
      version: "1.0.0",
    } as const;
    providers.list = [provider];
    providers.load
      .mockResolvedValueOnce({
        ...provider,
        main: { tooltip: "Old tooltip" },
        providerPluginId: provider.pluginId,
        renderer: { appName: "Old name" },
      })
      .mockResolvedValueOnce({
        ...provider,
        main: { tooltip: "New tooltip" },
        providerPluginId: provider.pluginId,
        renderer: { appName: "New name" },
      });

    await setMainLocaleSelection({
      locale: provider.locale,
      providerPluginId: provider.pluginId,
    });
    const listener = vi.fn();
    const dispose = onMainLocaleChanged(listener);

    const state = await revalidateMainLocalization();

    expect(state.renderer).toEqual({ appName: "New name" });
    expect(getMainLocaleText("tooltip")).toBe("New tooltip");
    expect(listener).toHaveBeenCalledTimes(1);
    dispose();
  });
});
