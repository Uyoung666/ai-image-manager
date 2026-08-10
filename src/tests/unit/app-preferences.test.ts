import { describe, expect, it } from "vitest";
import { parseAccentColor } from "@/types/accent-color";
import {
  APP_PREFERENCE_DEFAULTS,
  APP_PREFERENCE_KEYS,
  parseBooleanPreference,
  parseCloseBehavior,
} from "@/types/app-preferences";

describe("app preference defaults and validation", () => {
  it("keeps the product defaults stable", () => {
    expect(APP_PREFERENCE_DEFAULTS).toEqual({
      accentColor: "default",
      closeBehavior: "tray",
      reduceMotion: false,
      rememberBounds: false,
      updateAutoUpdate: true,
      updateReminder: true,
    });
  });

  it("round-trips valid boolean and close behavior values", () => {
    expect(parseBooleanPreference("true", false)).toBe(true);
    expect(parseBooleanPreference("false", true)).toBe(false);
    expect(parseCloseBehavior("tray")).toBe("tray");
    expect(parseCloseBehavior("quit")).toBe("quit");
    expect(parseCloseBehavior("ask")).toBe("ask");
    expect(parseAccentColor("pink")).toBe("pink");
    expect(APP_PREFERENCE_KEYS.accentColor).toBe("ui.accentColor");
  });

  it("falls back when persisted values are invalid", () => {
    expect(parseBooleanPreference("yes", true)).toBe(true);
    expect(parseBooleanPreference("no", false)).toBe(false);
    expect(parseCloseBehavior("minimize")).toBe("tray");
    expect(parseCloseBehavior(null)).toBe("tray");
    expect(parseAccentColor("indigo")).toBe("default");
    expect(parseAccentColor("purple")).toBe("default");
    expect(parseAccentColor(null)).toBe("default");
  });
});
