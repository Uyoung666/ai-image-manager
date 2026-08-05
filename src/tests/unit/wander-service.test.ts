import { describe, expect, it } from "vitest";
import {
  GetWanderSessionSchema,
  RecordWanderExposureSchema,
  SaveWanderSessionToAlbumSchema,
} from "@/ipc/wander/schemas";
import { chooseWanderMode, shuffleCandidates } from "@/ipc/wander/service";
import { DEFAULT_WANDER_SETTINGS, parseWanderSettings } from "@/types/wander";

describe("wander schemas", () => {
  it("applies defaults and validates allowed modes", () => {
    expect(GetWanderSessionSchema.parse({ mode: "auto" })).toEqual({
      mode: "auto",
      limit: 8,
    });
    expect(
      GetWanderSessionSchema.safeParse({ mode: "auto", allowedModes: [] })
        .success
    ).toBe(false);
    expect(
      GetWanderSessionSchema.safeParse({ mode: "theme", limit: 13 }).success
    ).toBe(false);
  });

  it("accepts only the two supported exposure sources", () => {
    expect(
      RecordWanderExposureSchema.safeParse({ photoId: 1, source: "wander" })
        .success
    ).toBe(true);
    expect(
      RecordWanderExposureSchema.safeParse({ photoId: 1, source: "gallery" })
        .success
    ).toBe(false);
  });

  it("deduplicates album photos without allowing a one-photo album", () => {
    expect(
      SaveWanderSessionToAlbumSchema.parse({
        title: "  Wander picks  ",
        photoIds: [3, 2, 3],
      })
    ).toEqual({ title: "Wander picks", photoIds: [3, 2] });
    expect(
      SaveWanderSessionToAlbumSchema.safeParse({
        title: "Duplicates",
        photoIds: [3, 3],
      }).success
    ).toBe(false);
  });
});

describe("wander selection helpers", () => {
  it("honors an explicitly requested mode", () => {
    expect(chooseWanderMode("theme", ["rediscovery"], () => 0)).toBe("theme");
  });

  it("selects auto mode only from the allowed set", () => {
    expect(
      chooseWanderMode("auto", ["timeCapsule", "rediscovery"], () => 0.99)
    ).toBe("rediscovery");
  });

  it("shuffles without mutating the candidate list", () => {
    const source = [1, 2, 3, 4];
    const shuffled = shuffleCandidates(source, () => 0);
    expect(source).toEqual([1, 2, 3, 4]);
    expect(shuffled).toEqual([2, 3, 4, 1]);
  });
});

describe("wander settings parser", () => {
  it("parses valid persisted settings", () => {
    expect(
      parseWanderSettings([
        { key: "wander.enabled", value: "true" },
        { key: "wander.idleMinutes", value: "30" },
        { key: "wander.intervalSeconds", value: "3" },
        { key: "wander.modes", value: '["theme","theme","rediscovery"]' },
      ])
    ).toEqual({
      enabled: true,
      idleMinutes: 30,
      intervalSeconds: 3,
      modes: ["theme", "rediscovery"],
    });
  });

  it("falls back safely for corrupt persisted values", () => {
    expect(
      parseWanderSettings([
        { key: "wander.enabled", value: "yes" },
        { key: "wander.idleMinutes", value: "99" },
        { key: "wander.intervalSeconds", value: "fast" },
        { key: "wander.modes", value: "not-json" },
      ])
    ).toEqual(DEFAULT_WANDER_SETTINGS);
  });
});
