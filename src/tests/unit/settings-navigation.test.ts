import { describe, expect, it } from "vitest";
import {
  filterSettingsNavigationItems,
  SETTINGS_GROUP_ORDER,
  SETTINGS_NAV_ITEMS,
} from "@/components/settings/SettingsSidebar";

const translations: Record<string, string> = {
  cloudSync: "云同步",
  settingsAbout: "关于",
  settingsAppearance: "外观",
  settingsBehavior: "应用行为",
  settingsCloseBehavior: "关闭行为",
  settingsGroupAppearance: "外观与交互",
  settingsGroupBehavior: "应用行为",
  settingsGroupData: "数据与性能",
  settingsGroupOutput: "输出与同步",
  settingsGroupPhotos: "照片体验",
  settingsGroupUpdates: "更新与日志",
  settingsGroupHelp: "帮助与支持",
  settingsDiagnostics: "帮助与诊断",
  settingsStorage: "存储",
};

const translate = (key: string) => translations[key] || key;

describe("settings navigation", () => {
  it("keeps the seven settings groups in product order", () => {
    expect(SETTINGS_GROUP_ORDER).toEqual([
      "settingsGroupAppearance",
      "settingsGroupBehavior",
      "settingsGroupPhotos",
      "settingsGroupData",
      "settingsGroupOutput",
      "settingsGroupUpdates",
      "settingsGroupHelp",
    ]);
  });

  it("includes the dedicated behavior page", () => {
    expect(SETTINGS_NAV_ITEMS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          groupKey: "settingsGroupBehavior",
          to: "/settings/behavior",
        }),
      ])
    );
  });

  it("includes a searchable diagnostics page", () => {
    expect(SETTINGS_NAV_ITEMS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          groupKey: "settingsGroupHelp",
          to: "/settings/diagnostics",
        }),
      ])
    );
    expect(filterSettingsNavigationItems("日志", translate)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to: "/settings/diagnostics" }),
      ])
    );
  });

  it("matches a translated title and a keyword", () => {
    expect(filterSettingsNavigationItems("关闭行为", translate)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to: "/settings/behavior" }),
      ])
    );
    expect(filterSettingsNavigationItems("thumbnail", translate)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to: "/settings/storage" }),
      ])
    );
  });

  it("does not return settings for an empty query", () => {
    expect(filterSettingsNavigationItems("   ", translate)).toEqual([]);
  });
});
