import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  normalizeLocaleTag,
  validateLocaleBundle,
  validateLocaleProviderSummary,
} from "@/localization/catalog";

describe("localization catalog boundary", () => {
  const readCatalog = (name: string) =>
    JSON.parse(
      fs.readFileSync(
        `external-plugins/japanese-locale/locales/ja-JP/${name}.json`,
        "utf8"
      )
    );
  const provider = {
    locale: "ja-JP",
    nativeName: "日本語",
    providerPluginId: "com.aiimagemanager.japanese-locale",
    main: readCatalog("main"),
  };

  it("activates the actual official Japanese catalog after installation", () => {
    expect(
      validateLocaleBundle({ ...provider, renderer: readCatalog("renderer") })
    ).not.toBeNull();
  });

  it.each([
    false,
    true,
  ])("enforces the object boundary (nested=%s)", (nested) => {
    const catalog = Object.fromEntries(
      Array.from({ length: 4096 }, (_, index) => [`key${index}`, "翻訳"])
    );
    const bundle = () => ({
      ...provider,
      renderer: nested ? { nested: catalog } : catalog,
    });
    expect(validateLocaleBundle(bundle())).not.toBeNull();
    catalog.overflow = "翻訳";
    expect(validateLocaleBundle(bundle())).toBeNull();
  });

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
