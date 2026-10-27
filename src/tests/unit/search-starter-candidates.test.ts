import { describe, expect, it } from "vitest";
import {
  buildStarterCandidates,
  localSearchDay,
  type StarterConcept,
  type StarterPhotoEvidence,
  type StarterTagEvidence,
} from "@/services/search-starter-candidates";
import { selectStarterBatch } from "@/services/search-starter-rotation";
import type {
  SearchStarter,
  SearchStarterInput,
} from "@/types/search-starters";

const now = new Date(2026, 9, 27, 12);
const vocabulary: StarterConcept[] = [
  { zh: "海滩", en: "beach", category: "scene" },
  { zh: "日落", en: "sunset", category: "lighting" },
  { zh: "猫咪", en: "cat", category: "animal" },
  { zh: "花卉", en: "flowers", category: "object" },
  { zh: "城市", en: "city", category: "scene" },
];
const photos: StarterPhotoEvidence[] = Array.from(
  { length: 10 },
  (_, index) => ({
    id: index + 1,
    dateTaken: new Date(2023, 1, 12).getTime(),
    favorite: index >= 4,
    views: index >= 4 ? 3 : 0,
    lastViewedAt: null,
  })
);
const evidence: StarterTagEvidence[] = vocabulary.flatMap((item, index) => [
  { name: item.zh, photoId: index * 2 + 1, manual: true },
  { name: item.zh, photoId: index * 2 + 2, manual: true },
]);
const input: SearchStarterInput = { language: "zh", history: [], filters: {} };

describe("search starter candidates", () => {
  it("only combines themes supported by the same photos", () => {
    const separate = buildStarterCandidates(
      input,
      photos,
      evidence,
      vocabulary,
      now
    );
    expect(separate.some((item) => item.topics.length > 1)).toBe(false);
    const together = buildStarterCandidates(
      input,
      photos,
      [
        ...evidence,
        { name: "日落", photoId: 1, manual: false },
        { name: "日落", photoId: 2, manual: false },
      ],
      vocabulary,
      now
    );
    expect(
      together.find(
        (item) => item.topics.length === 2 && item.topics.includes("海滩")
      )
    ).toMatchObject({ photoIds: [1, 2] });
  });

  it("uses capture dates and local month boundaries for rediscovery in both languages", () => {
    for (const language of ["zh", "en"] as const) {
      const candidates = buildStarterCandidates(
        { ...input, language },
        photos,
        evidence,
        vocabulary,
        now
      );
      const dated = candidates.find((item) => item.filters);
      expect(dated).toMatchObject({
        filters: { dateFrom: "2023-02-01", dateTo: "2023-02-28" },
      });
      expect(dated?.query).not.toContain("2023");
      expect(dated?.text).toContain("2023");
      const filtered = buildStarterCandidates(
        { ...input, filters: { dateFrom: 1 } },
        photos,
        evidence,
        vocabulary,
        now
      );
      expect(filtered.every((item) => !item.filters)).toBe(true);
    }
    const undated = buildStarterCandidates(
      input,
      photos.map((photo) => ({ ...photo, dateTaken: null })),
      evidence,
      vocabulary,
      now
    );
    expect(undated.some((item) => item.source === "rediscovery")).toBe(false);
  });

  it("uses existing preferences while avoiding exact history repetition", () => {
    const candidates = buildStarterCandidates(
      { ...input, history: ["海滩", "城市夜景"] },
      photos,
      evidence,
      vocabulary,
      now
    );
    expect(candidates.some((item) => item.text === "海滩")).toBe(false);
    expect(
      candidates.some(
        (item) => item.source === "interest" && item.topics.includes("城市")
      )
    ).toBe(true);
  });

  it("is deterministic within a local day and needs real photo evidence", () => {
    expect(
      buildStarterCandidates(input, photos, evidence, vocabulary, now)
    ).toEqual(
      buildStarterCandidates(
        input,
        photos,
        evidence,
        vocabulary,
        new Date(2026, 9, 27, 23)
      )
    );
    expect(localSearchDay(new Date(2026, 0, 2))).toBe("2026-01-02");
    expect(
      buildStarterCandidates(input, [], evidence, vocabulary, now)
    ).toEqual([]);
    expect(
      buildStarterCandidates(input, [photos[0]], [], vocabulary, now)
    ).toEqual([]);
  });

  it("selects a diverse 2/1/1 batch and rotates away from previous topics", () => {
    const candidates: SearchStarter[] = Array.from(
      { length: 12 },
      (_, index) => ({
        key: `theme-${index}`,
        text: `Theme ${index}`,
        topics: [`topic-${index}`],
        source: (["library", "library", "interest", "rediscovery"] as const)[
          Math.floor(index / 3)
        ],
      })
    );
    const first = selectStarterBatch(candidates);
    expect(first.map((item) => item.source)).toEqual([
      "library",
      "library",
      "interest",
      "rediscovery",
    ]);
    const next = selectStarterBatch(candidates, first);
    expect(
      next.every((item) => !first.some((previous) => previous.key === item.key))
    ).toBe(true);
    expect(
      selectStarterBatch([
        { ...candidates[0], key: "a" },
        { ...candidates[0], key: "b" },
      ])
    ).toHaveLength(1);
  });
});
