// @vitest-environment node
import { call } from "@orpc/server";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exifData, photos, photoTags, tags } from "@/db/schema";
import type { SearchStarterInput } from "@/types/search-starters";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  search: vi.fn(),
  ready: true,
  fingerprint: "model-a",
}));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));
vi.mock("@/services/ai-embedder", () => ({
  isAiSearchReady: () => state.ready,
  searchByTextWithPlan: state.search,
}));
vi.mock("@/services/ai/model-fingerprint", () => ({
  getActiveEmbeddingFingerprint: () => state.fingerprint,
}));
vi.mock("@/services/ai/threshold-profile", () => ({
  getSemanticSearchThresholdIdentity: () => "calibrated-v1",
}));
vi.mock("@/services/ai/search-sensitivity", () => ({
  getActiveSearchSensitivity: () => "standard",
}));
vi.mock("@/services/ai/state", () => ({ getAiControlState: () => "idle" }));
vi.mock("@/services/ai/tag-suggester", () => ({
  CANDIDATE_TAGS: [
    { zh: "海滩", siglipLabel: "a beach", category: "scene" },
    { zh: "日落", siglipLabel: "a sunset", category: "lighting" },
    { zh: "猫咪", siglipLabel: "a cat", category: "animal" },
    { zh: "城市", siglipLabel: "a city", category: "scene" },
  ],
}));

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;
const input: SearchStarterInput = {
  language: "zh",
  history: [],
  filters: { cameraModel: "Canon" },
};

beforeEach(() => {
  vi.resetModules();
  sqlite = new Database(":memory:");
  db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "drizzle" });
  state.db = db;
  state.ready = true;
  state.fingerprint = "model-a";
  state.search
    .mockReset()
    .mockImplementation(async (_query, _limit, options) => ({
      results: options.allowedPhotoIds.map((photoId: number) => ({
        photoId,
        similarity: 0.9,
      })),
      strongAccepted: options.allowedPhotoIds.length,
      supportedAccepted: 0,
    }));
  for (let id = 1; id <= 8; id++) {
    db.insert(photos)
      .values({
        id,
        path: `/fixture/${id}.jpg`,
        filename: `${id}.jpg`,
        isFavorite: id >= 5,
        deletedAt: id === 8 ? 1 : null,
      })
      .run();
    db.insert(exifData)
      .values({
        photoId: id,
        cameraModel: id <= 6 ? "Canon" : "Nikon",
        dateTaken: new Date(2023, 1, 12).getTime(),
      })
      .run();
  }
  for (const [index, name] of ["海滩", "日落", "猫咪", "城市"].entries()) {
    db.insert(tags)
      .values({ id: index + 1, name })
      .run();
    for (const photoId of [index * 2 + 1, index * 2 + 2]) {
      db.insert(photoTags)
        .values({ tagId: index + 1, photoId, origin: "manual" })
        .run();
    }
  }
});
afterEach(() => {
  sqlite.close();
  vi.restoreAllMocks();
});

describe("local search starter service and IPC", () => {
  it("validates within the exact metadata scope and caches accepted candidates", async () => {
    const { getSearchStarters } = await import("@/services/search-starters");
    const first = await getSearchStarters(input);
    expect(first.status).toBe("ready");
    expect(
      state.search.mock.calls.find(([query]) => query === "海滩")?.[2]
        .allowedPhotoIds
    ).toEqual([1, 2, 3, 4, 5, 6]);
    expect(first.candidates.some((item) => item.source === "rediscovery")).toBe(
      true
    );
    expect(
      state.search.mock.calls.every(([, , options]) =>
        options.allowedPhotoIds.every((id: number) => id <= 6)
      )
    ).toBe(true);
    const calls = state.search.mock.calls.length;
    expect(await getSearchStarters(input)).toBe(first);
    expect(state.search).toHaveBeenCalledTimes(calls);
    db.insert(tags).values({ name: "New topic" }).run();
    const changed = await getSearchStarters(input);
    expect(changed.revision).not.toBe(first.revision);
    expect(state.search.mock.calls.length).toBeGreaterThan(calls);
    state.fingerprint = "model-b";
    expect((await getSearchStarters(input)).revision).not.toBe(
      changed.revision
    );
  });

  it("does not mistake uncalibrated or weak nonempty top-K for useful recommendations", async () => {
    state.search.mockImplementation(async (_query, _limit, options) => ({
      results: options.allowedPhotoIds.map((photoId: number) => ({
        photoId,
        similarity: 0.01,
      })),
      strongAccepted: 0,
      supportedAccepted: 0,
    }));
    const { getSearchStarters } = await import("@/services/search-starters");
    const result = await getSearchStarters(input);
    expect(result).toMatchObject({ status: "empty", candidates: [] });
    expect(state.search.mock.calls.length).toBeLessThanOrEqual(16);
  });

  it("validates different themes before spending the budget on their dated variants", async () => {
    db.delete(photoTags).run();
    db.delete(tags).run();
    const themes = Array.from({ length: 12 }, (_, index) => `旅行主题${index}`);
    for (const [index, name] of themes.entries()) {
      db.insert(tags)
        .values({ id: index + 1, name })
        .run();
      for (const photoId of [1, 2]) {
        db.insert(photoTags)
          .values({ photoId, tagId: index + 1, origin: "manual" })
          .run();
      }
    }
    const { getSearchStarters } = await import("@/services/search-starters");
    const response = await getSearchStarters(input);
    expect(
      new Set(state.search.mock.calls.slice(0, 12).map(([query]) => query)).size
    ).toBe(12);
    expect(
      new Set(response.candidates.flatMap((candidate) => candidate.topics)).size
    ).toBe(12);
    expect(state.search.mock.calls.length).toBeLessThanOrEqual(16);
  });

  it("does not promote tag names that would execute as time, wildcard or color commands", async () => {
    for (const [index, name] of ["今年", "*.jpg", "#ffffff"].entries()) {
      const tagId = index + 20;
      db.insert(tags).values({ id: tagId, name }).run();
      for (const photoId of [1, 2]) {
        db.insert(photoTags).values({ tagId, photoId, origin: "manual" }).run();
      }
    }
    const { getSearchStarters } = await import("@/services/search-starters");
    const response = await getSearchStarters(input);
    expect(
      response.candidates.every(
        (candidate) =>
          !["今年", "*.jpg", "#ffffff"].includes(
            candidate.query ?? candidate.text
          )
      )
    ).toBe(true);
    expect(
      state.search.mock.calls.every(
        ([query]) => !["今年", "*.jpg", "#ffffff"].includes(query)
      )
    ).toBe(true);
  });

  it("handles empty scopes, unavailable models and color searches without inference", async () => {
    const { getSearchStarters } = await import("@/services/search-starters");
    expect(
      await getSearchStarters({ ...input, filters: { cameraModel: "Missing" } })
    ).toMatchObject({ status: "empty", candidates: [] });
    state.ready = false;
    expect((await getSearchStarters(input)).status).toBe("unavailable");
    expect(
      (await getSearchStarters({ ...input, colorHex: "abcdef" })).status
    ).toBe("color");
    expect(state.search).not.toHaveBeenCalled();
  });

  it("gives foreground searches priority and stops scheduling further validation", async () => {
    const { beginForegroundSearch } = await import(
      "@/services/search-background"
    );
    const finish = beginForegroundSearch();
    const { getSearchStarters } = await import("@/services/search-starters");
    expect((await getSearchStarters(input)).status).toBe("busy");
    expect(state.search).not.toHaveBeenCalled();
    finish();
    let stop: (() => void) | undefined;
    state.search.mockImplementation((_query, _limit, options) => {
      stop = beginForegroundSearch();
      expect(options.signal.aborted).toBe(true);
      return Promise.resolve({
        results: [],
        strongAccepted: 0,
        supportedAccepted: 0,
      });
    });
    expect((await getSearchStarters(input)).status).toBe("busy");
    expect(state.search).toHaveBeenCalledTimes(1);
    stop?.();
  });

  it("returns a retryable failure and coalesces concurrent requests", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    state.search.mockRejectedValue(new Error("worker unavailable"));
    const { getSearchStarters } = await import("@/services/search-starters");
    const [first, second] = await Promise.all([
      getSearchStarters(input),
      getSearchStarters(input),
    ]);
    expect(first).toBe(second);
    expect(first.status).toBe("error");
    expect(state.search).toHaveBeenCalledTimes(1);
    state.search.mockResolvedValue({
      results: [],
      strongAccepted: 0,
      supportedAccepted: 0,
    });
    expect((await getSearchStarters(input)).status).toBe("empty");
  });

  it("validates typed IPC inputs and uses the same filters as searches", async () => {
    const { getSearchStarters } = await import(
      "@/ipc/photos/handlers/search-starters"
    );
    const result = await call(getSearchStarters, input);
    expect(result.status).toBe("ready");
    await expect(
      call(getSearchStarters, {
        ...input,
        history: new Array(21).fill("topic"),
      })
    ).rejects.toThrow();
    await expect(
      call(getSearchStarters, { ...input, filters: { dateMonth: 13 } })
    ).rejects.toThrow();
  });

  it("returns only accepted, scoped evidence as semantic cover IDs", async () => {
    state.search.mockResolvedValue({
      results: [{ photoId: 2 }, { photoId: 7 }, { photoId: 8 }],
      strongAccepted: 1,
      supportedAccepted: 0,
    });
    const { getSearchStarters } = await import("@/services/search-starters");
    const result = await getSearchStarters(input);
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(
      result.candidates.every(
        (candidate) =>
          candidate.kind === "semantic" &&
          candidate.previewPhotoIds?.join() === "2"
      )
    ).toBe(true);
  });

  it("provides scoped month and trusted tag cards without a model or inference", async () => {
    state.ready = false;
    db.insert(tags).values({ id: 30, name: "未确认" }).run();
    db.insert(photoTags)
      .values({ tagId: 30, photoId: 1, origin: "auto", confidence: 0.99 })
      .run();
    const { getSearchStarterFallbacks } = await import(
      "@/services/search-starter-fallbacks"
    );
    const result = getSearchStarterFallbacks(input);
    expect(result.status).toBe("ready");
    expect(result.candidates.some((item) => item.kind === "month")).toBe(true);
    expect(result.candidates.some((item) => item.query === '"海滩"')).toBe(
      true
    );
    expect(result.candidates.some((item) => item.text === "未确认")).toBe(
      false
    );
    expect(
      result.candidates.every(
        (item) =>
          item.previewPhotoIds?.length &&
          item.previewPhotoIds.length <= 3 &&
          item.previewPhotoIds.every((id) => id <= 6)
      )
    ).toBe(true);
    expect(state.search).not.toHaveBeenCalled();
    const { getSearchStarterFallbacks: handler } = await import(
      "@/ipc/photos/handlers/search-starters"
    );
    expect((await call(handler, input)).candidates).toEqual(result.candidates);
    expect(
      getSearchStarterFallbacks({
        ...input,
        language: "en",
        locale: "ja",
      }).candidates.find((item) => item.kind === "month")?.text
    ).toBe("2023年2月");
  });

  it("intersects month cards with local date boundaries and distinguishes empty scopes", async () => {
    const { getSearchStarterFallbacks } = await import(
      "@/services/search-starter-fallbacks"
    );
    const result = getSearchStarterFallbacks({
      ...input,
      filters: {
        ...input.filters,
        dateFrom: new Date(2023, 1, 10).getTime(),
        dateTo: new Date(2023, 1, 20, 23, 59, 59, 999).getTime(),
      },
    });
    expect(
      result.candidates.find((item) => item.kind === "month")
    ).toMatchObject({
      query: "",
      filters: { dateFrom: "2023-02-10", dateTo: "2023-02-20" },
    });
    expect(
      getSearchStarterFallbacks({
        ...input,
        filters: { cameraModel: "Missing" },
      })
    ).toMatchObject({ status: "empty", emptyReason: "scope" });
    db.update(photos).set({ deletedAt: 1 }).run();
    expect(getSearchStarterFallbacks(input)).toMatchObject({
      status: "empty",
      emptyReason: "library",
    });
    expect(
      getSearchStarterFallbacks({ ...input, colorHex: "ff0000" })
    ).toMatchObject({ status: "color", candidates: [] });
  });

  it("refreshes metadata covers after data changes and cannot turn a quoted tag into a command", async () => {
    const { getSearchStarterFallbacks } = await import(
      "@/services/search-starter-fallbacks"
    );
    const before = getSearchStarterFallbacks(input);
    db.insert(tags).values({ id: 40, name: "今年" }).run();
    db.insert(photoTags)
      .values({ tagId: 40, photoId: 1, origin: "manual" })
      .run();
    const after = getSearchStarterFallbacks(input);
    expect(after.revision).not.toBe(before.revision);
    expect(after.candidates.find((item) => item.text === "今年")?.query).toBe(
      '"今年"'
    );
    const { rewriteQuery } = await import("@/services/query-rewrite");
    expect(rewriteQuery('"今年"').timeFilter).toBeUndefined();
    db.update(photos)
      .set({ deletedAt: 1 })
      .where((await import("drizzle-orm")).eq(photos.id, 1))
      .run();
    expect(
      getSearchStarterFallbacks(input).candidates.every(
        (item) => !item.previewPhotoIds?.includes(1)
      )
    ).toBe(true);
  });
});
