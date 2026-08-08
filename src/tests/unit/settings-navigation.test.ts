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
  settingsGroupUpdates: "更新与关于",
  settingsStorage: "存储",
};

const translate = (key: string) => translations[key] || key;

describe("settings navigation", () => {
  it("keeps the six settings groups in product order", () => {
    expect(SETTINGS_GROUP_ORDER).toEqual([
      "settingsGroupAppearance",
      "settingsGroupBehavior",
      "settingsGroupPhotos",
      "settingsGroupData",
      "settingsGroupOutput",
      "settingsGroupUpdates",
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
