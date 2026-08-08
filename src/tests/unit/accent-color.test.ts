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

  it("contains the eight screenshot-matched presets", () => {
    expect(ACCENT_COLOR_OPTIONS).toEqual([
      { color: "#B4B4B4", labelKey: "accentColorDefault", value: "default" },
      { color: "#3A83F7", labelKey: "accentColorBlue", value: "blue" },
      { color: "#53B559", labelKey: "accentColorGreen", value: "green" },
      { color: "#F6C543", labelKey: "accentColorYellow", value: "yellow" },
      { color: "#F077AF", labelKey: "accentColorPink", value: "pink" },
      { color: "#EE7C37", labelKey: "accentColorOrange", value: "orange" },
      { color: "#8952EE", labelKey: "accentColorPurple", value: "purple" },
      { color: "#000000", labelKey: "accentColorBlack", value: "black" },
    ]);
    expect(DEFAULT_ACCENT_COLOR).toBe("blue");
  });

  it("keeps gray exclusive to dark mode and black exclusive to light mode", () => {
    expect(getAccentColorOptions("dark").map((option) => option.value)).toEqual(
      ["default", "blue", "green", "yellow", "pink", "orange", "purple"]
    );
    expect(
      getAccentColorOptions("light").map((option) => option.value)
    ).toEqual(["blue", "green", "yellow", "pink", "orange", "purple", "black"]);
    expect(parseAccentColor("default", "light")).toBe("blue");
    expect(parseAccentColor("black", "dark")).toBe("blue");
  });

  it("persists a blue fallback when a saved preset is unavailable in the theme", async () => {
    document.documentElement.classList.remove("dark");
    document.documentElement.classList.add("light");

    expect(getCurrentAccentTheme()).toBe("light");
    settingsMocks.getAppPreferences.mockResolvedValueOnce({
      accentColor: "default",
    });
    await expect(getAccentColorPreference()).resolves.toBe("blue");
    expect(document.documentElement).toHaveAttribute(
      "data-accent-color",
      "blue"
    );
    expect(settingsMocks.setAppPreference).toHaveBeenLastCalledWith({
      key: "ui.accentColor",
      value: "blue",
    });
    expect(readCachedAccentColor()).toBe("blue");
  });

  it("reads and applies the cached preset, falling back to blue", () => {
    expect(readCachedAccentColor()).toBe("blue");
    cacheAccentColor("pink");
    expect(readCachedAccentColor()).toBe("pink");
    expect(applyAccentColor("invalid")).toBe("blue");
    expect(document.documentElement).toHaveAttribute(
      "data-accent-color",
      "blue"
    );
  });

  it("loads the authoritative preference and updates the cache", async () => {
    settingsMocks.getAppPreferences.mockResolvedValueOnce({
      accentColor: "purple",
    });

    await expect(getAccentColorPreference()).resolves.toBe("purple");
    expect(document.documentElement).toHaveAttribute(
      "data-accent-color",
      "purple"
    );
    expect(readCachedAccentColor()).toBe("purple");
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
