import { vi } from "vitest";

vi.unmock("react-i18next");

import i18n from "@/localization/i18n";

function flatten(
  value: unknown,
  prefix = "",
  output = new Map<string, string>()
) {
  if (Array.isArray(value)) {
    output.set(prefix, "array");
    return output;
  }

  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, output);
    }
    return output;
  }

  output.set(prefix, typeof value);
  return output;
}

function interpolationNames(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }

  return [...value.matchAll(/{{\s*([^}]+?)\s*}}/g)]
    .map((match) => match[1].trim())
    .sort();
}

describe("i18n resources", () => {
  it("keeps Chinese and English translation keys structurally identical", () => {
    const zh = i18n.getResourceBundle("zh", "translation");
    const en = i18n.getResourceBundle("en", "translation");

    expect(zh).toBeDefined();
    expect(en).toBeDefined();
    expect([...flatten(zh).entries()].sort()).toEqual(
      [...flatten(en).entries()].sort()
    );
  });

  it("keeps interpolation parameters identical for every translation key", () => {
    const zh = i18n.getResourceBundle("zh", "translation");
    const en = i18n.getResourceBundle("en", "translation");
    const zhLeaves = flatten(zh);

    for (const key of zhLeaves.keys()) {
      const zhValue = key
        .split(".")
        .reduce<unknown>(
          (current, part) =>
            current && typeof current === "object"
              ? (current as Record<string, unknown>)[part]
              : undefined,
          zh
        );
      const enValue = key
        .split(".")
        .reduce<unknown>(
          (current, part) =>
            current && typeof current === "object"
              ? (current as Record<string, unknown>)[part]
              : undefined,
          en
        );

      expect(interpolationNames(zhValue), key).toEqual(
        interpolationNames(enValue)
      );
    }
  });
});
