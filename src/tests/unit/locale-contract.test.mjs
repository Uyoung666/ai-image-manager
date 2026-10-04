import { describe, expect, it } from "vitest";
import {
  checkLocaleContract,
  textHash,
} from "../../../scripts/locale-contract.mjs";

const source = {
  renderer: { greeting: "Hello {{name}}", list: ["One", "Two"] },
  main: { quit: "Quit" },
};
const translation = {
  renderer: { greeting: "こんにちは {{name}}", list: ["一", "二"] },
  main: { quit: "終了" },
};

describe("official Japanese translation gate", () => {
  it("accepts complete translations and catches structural, empty and interpolation regressions", () => {
    expect(checkLocaleContract({ source, translation }).errors).toEqual([]);
    const broken = {
      renderer: { greeting: "こんにちは {{user}}", list: [""] },
      main: { extra: "余分" },
    };
    const errors = checkLocaleContract({ source, translation: broken }).errors;
    expect(errors).toContain("renderer.greeting: interpolation mismatch");
    expect(errors).toContain("renderer.list: missing or mismatched structure");
    expect(errors).toContain("renderer.list.0: empty translation");
    expect(errors).toContain("main.quit: missing or mismatched structure");
    expect(errors).toContain("main.extra: extra translation");
  });

  it("requires updated Japanese or an exact source-hash review after English changes", () => {
    const current = structuredClone(source);
    current.main.quit = "Quit application";
    const input = {
      source: current,
      translation,
      previousSource: source,
      previousTranslation: translation,
    };
    expect(checkLocaleContract(input).errors).toContain(
      "main.quit: changed English requires updated Japanese or a source-hash review"
    );
    expect(
      checkLocaleContract({
        ...input,
        reviews: {
          "main.quit": {
            sourceSha256: textHash(current.main.quit),
            reason: "Existing Japanese still covers this meaning.",
          },
        },
      }).errors
    ).toEqual([]);
    expect(
      checkLocaleContract({
        ...input,
        reviews: {
          "main.quit": {
            sourceSha256: textHash(source.main.quit),
            reason: "Stale review",
          },
        },
      }).errors
    ).not.toEqual([]);
  });

  it("allows literal English only through a reviewed whitelist and preserves repeated parameters", () => {
    expect(
      checkLocaleContract({
        source: { name: "AI Image Manager" },
        translation: { name: "AI Image Manager" },
      }).errors
    ).toHaveLength(1);
    expect(
      checkLocaleContract({
        source: { name: "AI Image Manager" },
        translation: { name: "AI Image Manager" },
        reviews: {
          name: {
            sourceSha256: textHash("AI Image Manager"),
            reason: "Product name",
          },
        },
      }).errors
    ).toEqual([]);
    expect(
      checkLocaleContract({
        source: { value: "{{n}} of {{n}}" },
        translation: { value: "{{n}}" },
      }).errors
    ).toEqual(["value: interpolation mismatch"]);
  });
});
