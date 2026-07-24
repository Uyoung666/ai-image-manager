import { describe, expect, it } from "vitest";
import { filterSettingsNavigationItems } from "@/components/settings/SettingsSidebar";

const translations: Record<string, string> = {
  cloudSync: "云同步",
  settingsGroupExport: "导出与同步",
  settingsGroupGeneral: "通用",
  settingsGroupSystem: "系统",
  settingsStorage: "存储",
};

const translate = (key: string) => translations[key] || key;

describe("filterSettingsNavigationItems", () => {
  it("matches a settings title", () => {
    expect(filterSettingsNavigationItems("云同步", translate)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to: "/settings/cloud-sync" }),
      ])
    );
  });

  it("matches existing settings keywords", () => {
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
