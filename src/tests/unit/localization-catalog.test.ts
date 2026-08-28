import { describe, expect, it } from "vitest";
import {
  normalizeLocaleTag,
  validateLocaleBundle,
  validateLocaleProviderSummary,
} from "@/localization/catalog";

describe("localization catalog boundary", () => {
  it("canonicalizes BCP-47 tags and preserves built-in aliases", () => {
    expect(normalizeLocaleTag("zh")).toBe("zh");
    expect(normalizeLocaleTag("en-us")).toBe("en-US");
    expect(normalizeLocaleTag("not a locale")).toBeNull();
    expect(normalizeLocaleTag("../en")).toBeNull();
  });

  it("accepts only declarative string catalogs", () => {
    const bundle = validateLocaleBundle({
      main: { tooltip: "照片管理器" },
      nativeName: "日本語",
      providerPluginId: "com.example.japanese",
      renderer: {
        nested: { greeting: "こんにちは {{name}}" },
        phrases: ["一", "二"],
      },
      locale: "ja-JP",
      version: "1.0.0",
    });
    expect(bundle).toMatchObject({
      locale: "ja-JP",
      providerPluginId: "com.example.japanese",
    });

    expect(
      validateLocaleBundle({
        main: { tooltip: "ok" },
        nativeName: "Bad",
        providerPluginId: "com.example.bad",
        renderer: { count: 1 },
        locale: "ja-JP",
      })
    ).toBeNull();
    expect(
      validateLocaleBundle({
        main: { tooltip: "<script>alert(1)</script>" },
        nativeName: "Bad",
        providerPluginId: "com.example.bad",
        renderer: { greeting: "ok" },
        locale: "ja-JP",
      })
    ).toBeNull();
    expect(
      validateLocaleBundle({
        main: { tooltip: "javascript:alert(1)" },
        nativeName: "Bad",
        providerPluginId: "com.example.bad",
        renderer: { greeting: "ok\u0000" },
        locale: "ja-JP",
      })
    ).toBeNull();
  });

  it("rejects a provider summary that attempts to opt into RTL", () => {
    expect(
      validateLocaleProviderSummary({
        direction: "rtl",
        locale: "ar",
        nativeName: "العربية",
        pluginId: "com.example.arabic",
      })
    ).toBeNull();
  });
});
