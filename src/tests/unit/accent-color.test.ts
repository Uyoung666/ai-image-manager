import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyAccentColor,
  cacheAccentColor,
  getAccentColorPreference,
  getCurrentAccentTheme,
  readCachedAccentColor,
  setAccentColorPreference,
} from "@/actions/accent-color";
import {
  ACCENT_COLOR_OPTIONS,
  DEFAULT_ACCENT_COLOR,
  getAccentColorOptions,
  parseAccentColor,
} from "@/types/accent-color";

const settingsMocks = vi.hoisted(() => ({
  getAppPreferences: vi.fn(),
  setAppPreference: vi.fn(),
}));

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      settings: settingsMocks,
    },
  },
}));

describe("accent color preference", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-accent-color");
    document.documentElement.classList.remove("light");
    document.documentElement.classList.add("dark");
    settingsMocks.getAppPreferences.mockReset();
    settingsMocks.setAppPreference.mockReset();
    settingsMocks.getAppPreferences.mockResolvedValue({
      accentColor: "blue",
    });
    settingsMocks.setAppPreference.mockResolvedValue({ ok: true });
  });

  it("contains the eight accent color presets", () => {
    expect(ACCENT_COLOR_OPTIONS).toEqual([
      { color: "#8952EE", labelKey: "accentColorDefault", value: "default" },
      { color: "#3A83F7", labelKey: "accentColorBlue", value: "blue" },
      { color: "#53B559", labelKey: "accentColorGreen", value: "green" },
      { color: "#F6C543", labelKey: "accentColorYellow", value: "yellow" },
      { color: "#F077AF", labelKey: "accentColorPink", value: "pink" },
      { color: "#EE7C37", labelKey: "accentColorOrange", value: "orange" },
      { color: "#B4B4B4", labelKey: "accentColorGray", value: "gray" },
      { color: "#000000", labelKey: "accentColorBlack", value: "black" },
    ]);
    expect(DEFAULT_ACCENT_COLOR).toBe("default");
  });

  it("keeps the default preset purple and black exclusive to light mode", () => {
    expect(getAccentColorOptions("dark").map((option) => option.value)).toEqual(
      ["default", "blue", "green", "yellow", "pink", "orange", "gray"]
    );
    expect(
      getAccentColorOptions("light").map((option) => option.value)
    ).toEqual([
      "default",
      "blue",
      "green",
      "yellow",
      "pink",
      "orange",
      "black",
    ]);
    expect(parseAccentColor("default", "light")).toBe("default");
    expect(parseAccentColor("gray", "light")).toBe("default");
    expect(parseAccentColor("black", "dark")).toBe("default");
  });

  it("keeps the default preset available in the light theme", async () => {
    document.documentElement.classList.remove("dark");
    document.documentElement.classList.add("light");

    expect(getCurrentAccentTheme()).toBe("light");
    settingsMocks.getAppPreferences.mockResolvedValueOnce({
      accentColor: "default",
    });
    await expect(getAccentColorPreference()).resolves.toBe("default");
    expect(document.documentElement).toHaveAttribute(
      "data-accent-color",
      "default"
    );
    expect(settingsMocks.setAppPreference).not.toHaveBeenCalled();
    expect(readCachedAccentColor()).toBe("default");
  });

  it("reads and applies the cached preset, falling back to the default", () => {
    expect(readCachedAccentColor()).toBe("default");
    cacheAccentColor("pink");
    expect(readCachedAccentColor()).toBe("pink");
    expect(applyAccentColor("invalid")).toBe("default");
    expect(document.documentElement).toHaveAttribute(
      "data-accent-color",
      "default"
    );
  });

  it("loads the authoritative preference and updates the cache", async () => {
    settingsMocks.getAppPreferences.mockResolvedValueOnce({
      accentColor: "purple",
    });

    await expect(getAccentColorPreference()).resolves.toBe("default");
    expect(document.documentElement).toHaveAttribute(
      "data-accent-color",
      "default"
    );
    expect(settingsMocks.setAppPreference).toHaveBeenLastCalledWith({
      key: "ui.accentColor",
      value: "default",
    });
    expect(readCachedAccentColor()).toBe("default");
  });

  it("persists the selected preset through typed app preferences", async () => {
    await expect(setAccentColorPreference("orange")).resolves.toBe("orange");
    expect(settingsMocks.setAppPreference).toHaveBeenCalledWith({
      key: "ui.accentColor",
      value: "orange",
    });
    expect(document.documentElement).toHaveAttribute(
      "data-accent-color",
      "orange"
    );
    expect(readCachedAccentColor()).toBe("orange");
  });
});
