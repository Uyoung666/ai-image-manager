import { describe, expect, it } from "vitest";
import {
  APP_PREFERENCE_DEFAULTS,
  parseBooleanPreference,
  parseCloseBehavior,
} from "@/types/app-preferences";

describe("app preference defaults and validation", () => {
  it("keeps the product defaults stable", () => {
    expect(APP_PREFERENCE_DEFAULTS).toEqual({
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
  });

  it("falls back when persisted values are invalid", () => {
    expect(parseBooleanPreference("yes", true)).toBe(true);
    expect(parseBooleanPreference("no", false)).toBe(false);
    expect(parseCloseBehavior("minimize")).toBe("tray");
    expect(parseCloseBehavior(null)).toBe("tray");
  });
});
