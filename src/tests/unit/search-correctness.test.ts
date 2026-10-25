// @vitest-environment node
import { performance } from "node:perf_hooks";
import { call } from "@orpc/server";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  advancedExifData,
  exifData,
  faceIdentities,
  faceIdentityMembers,
  faceVectors,
  photos,
  photoTags,
  tags,
} from "@/db/schema";
import { fuseRankedSearchEvidence } from "@/services/ai/scoring";
import { rewriteQuery } from "@/services/query-rewrite";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  search: vi.fn(),
  colorSearch: vi.fn(),
  coverage: "ready",
  readiness: vi.fn(),
  aiReady: true,
}));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));
vi.mock("@/services/ai-embedder", () => ({
  searchByTextWithPlan: state.search,
  isAiSearchReady: () => state.aiReady,
}));
vi.mock("@/services/ai/health", () => ({
  getAiReadiness: state.readiness,
}));
vi.mock("@/services/image-search-preview", () => ({}));
vi.mock("@/services/ai/vector-db", () => ({
  searchByColorVector: state.colorSearch,
}));
vi.mock("@/services/ai/search-sensitivity", () => ({
  getActiveSearchSensitivity: () => "standard",
  getSensitivityMultiplier: () => 1,
}));
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;
beforeEach(() => {
  vi.resetModules();
  state.search.mockReset();
  state.colorSearch.mockReset().mockResolvedValue(null);
  state.coverage = "ready";
  state.aiReady = true;
  state.readiness.mockReset().mockImplementation(async () => ({
    coverageState: state.coverage,
    indexedPhotos: 3,
    totalPhotos: 3,
  }));
  sqlite = new Database(":memory:");
  db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "drizzle" });
  state.db = db;
  for (let id = 1; id <= 3; id++) {
    db.insert(photos)
      .values({
        id,
        filename: `fixture-${id}.jpg`,
        path: `/fixture/${id}.jpg`,
        fileDate: id,
        deletedAt: id === 3 ? 1 : null,
      })
      .run();
    db.insert(exifData)
      .values({
        photoId: id,
        iso: id === 1 ? 100 : 800,
        cameraModel: id === 1 ? "Canon" : "Nikon",
        dateTaken: 150,
      })
      .run();
  }
  state.search.mockImplementation(async (_query, _limit, options) => ({
    results: options.allowedPhotoIds.map((photoId: number) => ({
      photoId,
      similarity: 0.8,
      primarySimilarity: 0.8,
      rankScore: 0.1,
      supportingGroups: ["whole-query"],
    })),
    hasMore: false,
    strongCutoff: 0.1,
    supportCutoff: 0.05,
    plan: {
      intent: "scene",
      prompts: [{ text: "mountain" }],
      translationMode: "none",
      language: "en",
    },
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  sqlite.close();
});

function useSearchClock() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(0);
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
}

const emptySemanticResult = {
  results: [],
  hasMore: false,
  plan: { prompts: [], language: "en", translationMode: "none" },
};

describe("search correctness", () => {
  it("keeps filename hits when an unrelated photo changes during recall", async () => {
    state.search.mockImplementation(async () => {
      await Promise.resolve();
      sqlite.prepare("UPDATE exif_data SET iso = 50 WHERE photo_id = 2").run();
      return emptySemanticResult;
    });
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    const result = await call(searchCompound, { query: "fixture-1.jpg" });
    expect(result.results.map((row) => row.id)).toEqual([1]);
    expect(result.results[0].match).toEqual({
      kind: "exact",
      source: "filename",
    });
    expect(result).toMatchObject({
      completion: "partial",
      incompleteReason: "changed",
      totalExact: false,
      hasMore: false,
      nextCursor: null,
      nextOffset: null,
    });
    expect(state.search).toHaveBeenCalledTimes(1);
    expect(
      (await call(searchCompound, { query: "fixture-1.jpg" })).completion
    ).toBe("complete");
  });

  it("reuses semantic candidates with current metadata and hard filters", async () => {
    const originalSearch = state.search.getMockImplementation();
    state.search.mockImplementation(async (...args) => {
      const result = await originalSearch?.(...args);
      sqlite.prepare("UPDATE exif_data SET iso = 50 WHERE photo_id = 2").run();
      return result;
    });
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    const result = await call(searchCompound, {
      query: "mountain",
      isoMin: 100,
    });
    expect(result.results.map((row) => row.id)).toEqual([1]);
    expect(result.results[0].match).toMatchObject({
      kind: "hybrid",
      evidence: ["semantic"],
    });
    expect(result.incompleteReason).toBe("changed");
    expect(state.search).toHaveBeenCalledTimes(1);
  });

  it("discards stale vector evidence while keeping current filename hits", async () => {
    const { invalidateVectorSearch } = await import(
      "@/services/search-revision"
    );
    const originalSearch = state.search.getMockImplementation();
    state.search.mockImplementation(async (...args) => {
      const result = await originalSearch?.(...args);
      invalidateVectorSearch();
      return result;
    });
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    const result = await call(searchCompound, { query: "fixture-1.jpg" });
    expect(result.results.map((row) => row.id)).toEqual([1]);
    expect(result.semantic?.used).toBe(false);
    expect(result).toMatchObject({
      completion: "partial",
      incompleteReason: "changed",
      nextCursor: null,
    });
    expect(state.search).toHaveBeenCalledTimes(1);
  });

  it.each([
    "UPDATE photos SET deleted_at = 1 WHERE id = 1",
    "UPDATE photos SET filename = 'renamed.jpg' WHERE id = 1",
    "UPDATE exif_data SET iso = 50 WHERE photo_id = 1",
    "UPDATE exif_data SET date_taken = 50 WHERE photo_id = 1",
  ])("revalidates a filename hit after %s", async (mutation) => {
    state.search.mockImplementation(async () => {
      await Promise.resolve();
      sqlite.exec(mutation);
      return emptySemanticResult;
    });
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    const result = await call(searchCompound, {
      query: "fixture-1.jpg",
      isoMin: 100,
      dateFrom: 100,
      dateTo: 200,
    });
    expect(result.results).toEqual([]);
    expect(result.incompleteReason).toBe("changed");
  });

  it("includes new local matches when the hard-filter scope expands", async () => {
    state.search.mockImplementation(async () => {
      await Promise.resolve();
      sqlite.prepare("UPDATE exif_data SET iso = 900 WHERE photo_id = 1").run();
      return emptySemanticResult;
    });
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    const result = await call(searchCompound, {
      query: "fixture",
      isoMin: 800,
    });
    expect(result.results.map((row) => row.id).sort()).toEqual([1, 2]);
    expect(result.incompleteReason).toBe("changed");
    expect(state.search).toHaveBeenCalledTimes(1);
  });

  it.each([
    "tag",
    "person",
  ])("replaces stale %s name evidence before committing results", async (source) => {
    if (source === "tag") {
      const tag = db
        .insert(tags)
        .values({ name: "ExactAlpha" })
        .returning()
        .get();
      db.insert(photoTags)
        .values({ photoId: 1, tagId: tag.id, origin: "manual" })
        .run();
    } else {
      const person = db
        .insert(faceIdentities)
        .values({ name: "ExactAlpha" })
        .returning()
        .get();
      const face = db
        .insert(faceVectors)
        .values({ photoId: 1, bboxX: 0, bboxY: 0, bboxWidth: 1, bboxHeight: 1 })
        .returning()
        .get();
      db.insert(faceIdentityMembers)
        .values({ identityId: person.id, faceVectorId: face.id })
        .run();
    }
    state.search.mockImplementation(async () => {
      await Promise.resolve();
      sqlite.exec(
        source === "tag"
          ? "UPDATE tags SET name = 'ExactBeta'"
          : "UPDATE face_identities SET name = 'ExactBeta'"
      );
      return emptySemanticResult;
    });
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    const result = await call(searchCompound, { query: "ExactAlpha" });
    expect(result.results).toEqual([]);
    expect(result.incompleteReason).toBe("changed");
    const fresh = await call(searchCompound, { query: '"ExactBeta"' });
    expect(fresh.results.map((row) => row.id)).toEqual([1]);
  });

  it.each([
    { cold: false, budget: 2000 },
    { cold: true, budget: 10_000 },
  ])("retains local hits at the readiness deadline ($budget ms)", async ({
    cold,
    budget,
  }) => {
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    useSearchClock();
    state.aiReady = !cold;
    state.readiness.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ coverageState: "ready" }), budget + 300)
        )
    );
    const pending = call(searchCompound, { query: "fixture-1.jpg" });
    await vi.advanceTimersByTimeAsync(budget + 1);
    const result = await pending;
    expect(result.results.map((row) => row.id)).toEqual([1]);
    expect(result).toMatchObject({
      completion: "partial",
      incompleteReason: "deadline",
      totalExact: false,
    });
    expect(result.diagnostics?.cold).toBe(cold);
    await vi.advanceTimersByTimeAsync(500);
    expect(state.search).not.toHaveBeenCalled();
  });

  it("bounds a never-settling readiness check without discarding filename hits", async () => {
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    useSearchClock();
    state.readiness.mockImplementation(() => new Promise(() => undefined));
    const pending = call(searchCompound, { query: "fixture", isoMin: 800 });
    await vi.advanceTimersByTimeAsync(2001);
    const result = await pending;
    expect(result.results.map((row) => row.id)).toEqual([2]);
    expect(result.incompleteReason).toBe("deadline");
    expect(state.search).not.toHaveBeenCalled();
  });

  it("reports readiness failures while retaining local hits", async () => {
    state.readiness.mockRejectedValue(new Error("vector lease unavailable"));
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    const result = await call(searchCompound, { query: "fixture-1.jpg" });
    expect(result.results.map((row) => row.id)).toEqual([1]);
    expect(result).toMatchObject({
      completion: "partial",
      incompleteReason: "semantic-unavailable",
      totalExact: false,
    });
    expect(state.search).not.toHaveBeenCalled();
  });

  it("reports an unavailable SQLite store as an error after a scope cache hit", async () => {
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    await call(searchCompound, { query: "fixture" });
    sqlite.exec("ALTER TABLE photos RENAME TO unavailable_search_photos");
    try {
      await expect(
        call(searchCompound, { query: "fixture" })
      ).rejects.toThrow();
    } finally {
      sqlite.exec("ALTER TABLE unavailable_search_photos RENAME TO photos");
    }
  });

  it("skips AI readiness for quoted and wildcard filename searches", async () => {
    state.readiness.mockImplementation(() => new Promise(() => undefined));
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    for (const query of ['"fixture-1.jpg"', "fixture-1.*"]) {
      const result = await call(searchCompound, { query });
      expect(result.results.map((row) => row.id)).toEqual([1]);
      expect(result).toMatchObject({
        completion: "complete",
        semanticRequired: false,
      });
    }
    expect(state.readiness).not.toHaveBeenCalled();
    expect(state.search).not.toHaveBeenCalled();
  });

  it("revalidates local hits when data changes and readiness times out together", async () => {
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    useSearchClock();
    state.readiness.mockImplementation(() => new Promise(() => undefined));
    const pending = call(searchCompound, { query: "fixture", isoMin: 100 });
    await vi.advanceTimersByTimeAsync(100);
    sqlite.prepare("UPDATE exif_data SET iso = 50 WHERE photo_id = 2").run();
    await vi.advanceTimersByTimeAsync(1901);
    const result = await pending;
    expect(result.results.map((row) => row.id)).toEqual([1]);
    expect(result).toMatchObject({
      completion: "partial",
      incompleteReason: "changed",
      nextCursor: null,
    });
  });

  it("cancels a stalled readiness subscriber without publishing local or late AI results", async () => {
    let resolveReadiness!: (value: unknown) => void;
    state.readiness.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveReadiness = resolve;
        })
    );
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    const { cancelSearchRequest } = await import("@/services/search-control");
    const requestId = "00000000-0000-4000-8000-000000000001";
    const pending = call(searchCompound, { query: "fixture", requestId });
    await vi.waitFor(() => expect(state.readiness).toHaveBeenCalledTimes(1));
    expect(cancelSearchRequest(0, requestId)).toBe(true);
    expect(await pending).toMatchObject({
      results: [],
      completion: "cancelled",
    });
    const fresh = await call(searchCompound, { query: '"fixture-2.jpg"' });
    expect(fresh.results.map((row) => row.id)).toEqual([2]);
    resolveReadiness({ coverageState: "ready" });
    await Promise.resolve();
    expect(state.search).not.toHaveBeenCalled();
  });

  it("does not change a frozen local pool after late semantic completion", async () => {
    let finishSearch!: (value: unknown) => void;
    let publishCandidates!: (value: unknown) => void;
    state.search.mockImplementation((_query, _limit, options) => {
      publishCandidates = options.onCandidates;
      return new Promise((resolve) => {
        finishSearch = resolve;
      });
    });
    useSearchClock();
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    const pending = call(searchCompound, { query: "fixture", limit: 1 });
    await vi.advanceTimersByTimeAsync(2001);
    const first = await pending;
    expect(first.nextCursor).toBeTruthy();
    const late = {
      ...emptySemanticResult,
      results: [{ photoId: 1, similarity: 0.9, primarySimilarity: 0.9 }],
    };
    const snapshot = JSON.stringify(first);
    publishCandidates(late);
    finishSearch(late);
    await Promise.resolve();
    const next = await call(searchCompound, {
      query: "fixture",
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });
    expect(JSON.stringify(first)).toBe(snapshot);
    expect(next.cursorExpired).not.toBe(true);
    expect(next.results.map((row) => row.id)).toEqual([1]);
    expect([...first.results, ...next.results].map((row) => row.id)).toEqual([
      2, 1,
    ]);
    expect(next.hasMore).toBe(false);
    expect(state.search).toHaveBeenCalledTimes(1);
  });

  it("expires an in-flight cursor before consuming a changed candidate pool", async () => {
    const originalSearch = state.search.getMockImplementation();
    state.search.mockImplementationOnce(async (...args) => {
      const result = await originalSearch?.(...args);
      return {
        ...result,
        results: result.results.slice(0, 1),
        hasMore: true,
        candidateDepth: 1,
      };
    });
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    const first = await call(searchCompound, { query: "mountain", limit: 1 });
    expect(first.nextCursor).toBeTruthy();
    state.search.mockImplementationOnce(async (...args) => {
      const result = await originalSearch?.(...args);
      sqlite.prepare("UPDATE exif_data SET iso = 50 WHERE photo_id = 2").run();
      return result;
    });
    const next = await call(searchCompound, {
      query: "mountain",
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });
    expect(next).toMatchObject({
      cursorExpired: true,
      results: [],
      completion: "partial",
      incompleteReason: "changed",
      nextCursor: null,
    });
    expect(
      (
        await call(searchCompound, {
          query: "mountain",
          limit: 1,
          cursor: first.nextCursor ?? undefined,
        })
      ).cursorExpired
    ).toBe(true);
    const fresh = await call(searchCompound, { query: "mountain" });
    expect(fresh.results.map((row) => row.id).sort()).toEqual([1, 2]);
  });

  it("keeps every tag-supported result reachable regardless of page size", async () => {
    sqlite.prepare("UPDATE photos SET deleted_at = NULL WHERE id = 3").run();
    const tag = db.insert(tags).values({ name: "cat" }).returning().get();
    for (const photoId of [1, 2, 3]) {
      db.insert(photoTags)
        .values({ photoId, tagId: tag.id, origin: "auto", confidence: 0.9 })
        .run();
    }
    state.search.mockImplementation(async (_query, _limit, options) => ({
      results: [],
      supportCandidates: options.allowedPhotoIds.map((photoId: number) => ({
        photoId,
        primarySimilarity: 0.05,
        similarity: 0.05,
        rankScore: 0.01,
        supportingGroups: ["whole-query"],
      })),
      candidateDepth: 3,
      hasMore: false,
      strongCutoff: 0.055,
      supportCutoff: 0.046_75,
      topSimilarity: 0.06,
      plan: {
        intent: "object",
        prompts: [{ text: "cat" }],
        language: "en",
        translationMode: "none",
      },
    }));
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    const { withSearchQualityTrace } = await import(
      "@/services/search-quality-trace"
    );
    const smallIds: number[] = [];
    const observer = vi.fn();
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const result = await withSearchQualityTrace("tag-fixture", observer, () =>
        call(searchCompound, {
          query: "cat",
          limit: 1,
          cursor,
        })
      );
      expect(result.total).toBe(3);
      expect(result.totalExact).toBe(true);
      expect(result.hasMore).toBe(page < 2);
      smallIds.push(...result.results.map((row) => row.id));
      cursor = result.nextCursor ?? undefined;
    }
    const large = await call(searchCompound, { query: "cat", limit: 10 });
    expect(smallIds).toEqual(large.results.map((row) => row.id));
    expect(new Set(smallIds).size).toBe(3);
    const hybrid = observer.mock.calls
      .map(([event]) => event)
      .find((event) => event.stage === "hybrid-ranking");
    expect(hybrid.requestId).toBe("tag-fixture");
    expect(hybrid.data.tagEvidence).toHaveLength(3);
    expect(hybrid.data.diagnostics.tagSupportedAccepted).toBe(3);
  });

  it("expands candidate depth after fusion until a supported page is available", async () => {
    sqlite.prepare("UPDATE photos SET deleted_at = NULL WHERE id = 3").run();
    db.transaction(() => {
      for (let id = 4; id <= 450; id++) {
        db.insert(photos)
          .values({
            id,
            filename: `other-${id}.jpg`,
            path: `/fixture/${id}.jpg`,
          })
          .run();
      }
    });
    const tag = db.insert(tags).values({ name: "cat" }).returning().get();
    db.insert(photoTags)
      .values({ photoId: 450, tagId: tag.id, origin: "auto", confidence: 0.9 })
      .run();
    const depths: number[] = [];
    state.search.mockImplementation(async (_query, _limit, options) => {
      await Promise.resolve();
      const depth = Math.min(
        options.candidateDepth,
        options.allowedPhotoIds.length
      );
      depths.push(depth);
      return {
        results: [],
        supportCandidates: options.allowedPhotoIds
          .slice(0, depth)
          .map((photoId: number) => ({
            photoId,
            primarySimilarity: 0.05,
            similarity: 0.05,
            rankScore: 0.01,
            supportingGroups: ["whole-query"],
          })),
        candidateDepth: depth,
        hasMore: depth < options.allowedPhotoIds.length,
        strongCutoff: 0.055,
        supportCutoff: 0.046_75,
        topSimilarity: 0.06,
        plan: {
          intent: "object",
          prompts: [{ text: "cat" }],
          language: "en",
          translationMode: "none",
        },
      };
    });
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    const result = await call(searchCompound, { query: "cat", limit: 1 });
    expect(depths).toEqual([200, 400, 450]);
    expect(result.results.map((row) => row.id)).toEqual([450]);
    expect(result).toMatchObject({
      total: 1,
      totalExact: true,
      hasMore: false,
      completion: "complete",
    });
  });

  it("honors offsets and literal quoted filenames without visual inference", async () => {
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    const page = await call(searchCompound, {
      query: "*.jpg",
      limit: 1,
      offset: 1,
    });
    expect(page.results.map((row) => row.id)).toEqual([1]);
    const quoted = await call(searchCompound, { query: '"fixture-1.jpg"' });
    expect(quoted.results.map((row) => row.id)).toEqual([1]);
    expect(quoted.semantic).toMatchObject({ required: false, used: false });
    sqlite
      .prepare("UPDATE photos SET filename = '100_percent.jpg' WHERE id = 1")
      .run();
    sqlite
      .prepare("UPDATE photos SET filename = '100Xpercent.jpg' WHERE id = 2")
      .run();
    const literal = await call(searchCompound, { query: '"100_percent.jpg"' });
    expect(literal.results.map((row) => row.id)).toEqual([1]);
    expect(state.search).not.toHaveBeenCalled();
  });

  it("rehydrates favorites and thumbnails on an EXIF cache hit", async () => {
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    await call(searchCompound, { isoMin: 100 });
    sqlite
      .prepare(
        "UPDATE photos SET is_favorite = 1, thumbnail_path = 'new.webp' WHERE id = 1"
      )
      .run();
    const cached = await call(searchCompound, { isoMin: 100 });
    expect(cached.results.find((row) => row.id === 1)).toMatchObject({
      isFavorite: true,
      thumbnailPath: "new.webp",
    });
  });
  it("preserves full filename priority when FTS recall succeeds", async () => {
    sqlite
      .prepare("UPDATE photos SET filename = 'fixture-1.jpg-copy' WHERE id = 2")
      .run();
    expect(
      sqlite
        .prepare("SELECT rowid FROM photos_fts WHERE photos_fts MATCH ?")
        .all('"fixture-1.jpg"*')
    ).toHaveLength(2);
    state.search.mockResolvedValue({
      results: [],
      hasMore: false,
      plan: { prompts: [], language: "en", translationMode: "none" },
    });
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    const result = await call(searchCompound, { query: "fixture-1.jpg" });
    expect(result.results[0]).toMatchObject({
      id: 1,
      match: { kind: "exact", source: "filename" },
    });
  });
  it("keeps temporal words literal inside filenames, quoted tags and globs", async () => {
    sqlite
      .prepare("UPDATE photos SET filename = '昨天.jpg' WHERE id = 1")
      .run();
    sqlite
      .prepare("UPDATE photos SET filename = '春天-1.jpg' WHERE id = 2")
      .run();
    const tag = db.insert(tags).values({ name: "春天" }).returning().get();
    db.insert(photoTags)
      .values({ photoId: 1, tagId: tag.id, origin: "manual" })
      .run();
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    for (const [query, ids] of [
      ['"昨天.jpg"', [1]],
      ["“春天”", [1, 2]],
      ["春天*.jpg", [2]],
    ] as const) {
      const result = await call(searchCompound, { query });
      expect(result.results.map((row) => row.id).sort()).toEqual([...ids]);
      expect(result.timeFilter).toBeUndefined();
      expect(result.semanticRequired).toBe(false);
    }
    expect(state.search).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    "ff0000",
  ])("preserves parsed time metadata when the hard-filter scope is empty (color=%s)", async (colorHex) => {
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    const result = await call(searchCompound, {
      query: '"missing.jpg" 2024年3月',
      colorHex,
    });
    expect(result).toMatchObject({
      results: [],
      total: 0,
      totalExact: true,
      timeFilter: { dateFrom: "2024-03-01", dateTo: "2024-03-31" },
    });
    expect(state.search).not.toHaveBeenCalled();
  });

  it("applies hard filters to color supplements and paginates the complete set", async () => {
    sqlite.function("closest_color_dist", { varargs: true }, () => 0);
    sqlite
      .prepare("UPDATE photos SET dominant_colors = '[]', deleted_at = NULL")
      .run();
    state.colorSearch.mockResolvedValue([{ photoId: 2, distanceSquared: 0 }]);
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    const filtered = await call(searchCompound, {
      colorHex: "ff0000",
      cameraModel: "Canon",
      limit: 1,
    });
    expect(filtered.results.map((row) => row.id)).toEqual([1]);
    expect(filtered).toMatchObject({
      total: 1,
      totalExact: true,
      hasMore: false,
    });
    const ids: number[] = [];
    let cursor: string | undefined;
    for (let index = 0; index < 3; index++) {
      const page = await call(searchCompound, {
        colorHex: "ff0000",
        limit: 1,
        cursor,
      });
      expect(page.total).toBe(3);
      expect(page.hasMore).toBe(index < 2);
      ids.push(...page.results.map((row) => row.id));
      cursor = page.nextCursor ?? undefined;
    }
    expect(ids).toEqual([1, 2, 3]);
  });

  it("marks missing scoring vectors as incomplete", async () => {
    state.search.mockResolvedValue({
      results: [],
      supportCandidates: [],
      cutoffReason: "missing-photo-vector",
      hasMore: false,
      plan: { prompts: [], language: "en", translationMode: "none" },
    });
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    expect(await call(searchCompound, { query: "cat" })).toMatchObject({
      completion: "partial",
      totalExact: false,
      incompleteReason: "semantic-unavailable",
    });
  });
  it("rejects out-of-scope color vector supplements for combined filters", async () => {
    sqlite.function(
      "closest_color_dist",
      { varargs: true },
      () => Number.MAX_VALUE
    );
    sqlite.prepare("UPDATE photos SET dominant_colors = NULL").run();
    db.insert(advancedExifData)
      .values({
        photoId: 1,
        captureMode: "portrait",
        normalizedJson: JSON.stringify({ workflow: { artist: "Alice" } }),
      })
      .run();
    state.colorSearch.mockResolvedValue([
      { photoId: 1, distanceSquared: 0 },
      { photoId: 2, distanceSquared: 0 },
      { photoId: 3, distanceSquared: 0 },
    ]);
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    const result = await call(searchCompound, {
      colorHex: "ff0000",
      dateFrom: 100,
      dateTo: 200,
      cameraModel: "Canon",
      isoMax: 200,
      creator: "Alice",
      advancedField: "captureMode",
      advancedValue: "portrait",
    });
    expect(result.results.map((row) => row.id)).toEqual([1]);
    expect(state.colorSearch.mock.calls[0].slice(3)).toEqual([1, [1], true]);
    expect(result).toMatchObject({ total: 1, totalExact: true });
  });
  it("reports failed color supplementation as partial instead of exact", async () => {
    sqlite.function(
      "closest_color_dist",
      { varargs: true },
      (_r, _g, _b, palette) => (palette ? 0 : Number.MAX_VALUE)
    );
    sqlite
      .prepare("UPDATE photos SET dominant_colors = '[]' WHERE id = 1")
      .run();
    state.colorSearch.mockRejectedValue(new Error("color store unavailable"));
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    const result = await call(searchCompound, { colorHex: "ff0000" });
    expect(result.results.map((row) => row.id)).toEqual([1]);
    expect(result).toMatchObject({
      completion: "partial",
      totalExact: false,
      incompleteReason: "semantic-unavailable",
    });
  });
  it("does not let a stale color vector override a valid non-matching palette", async () => {
    sqlite.function(
      "closest_color_dist",
      { varargs: true },
      (_r, _g, _b, palette) => (palette ? 130_050 : Number.MAX_VALUE)
    );
    sqlite
      .prepare("UPDATE photos SET dominant_colors = 'blue' WHERE id = 1")
      .run();
    state.colorSearch.mockResolvedValue([
      { photoId: 1, distanceSquared: 0 },
      { photoId: 2, distanceSquared: 0 },
    ]);
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    const result = await call(searchCompound, { colorHex: "ff0000" });
    expect(result.results.map((row) => row.id)).toEqual([2]);
    expect(state.colorSearch.mock.calls[0].slice(3)).toEqual([1, [2], true]);
  });
  it("accepts advanced metadata and creators without a basic EXIF row", async () => {
    sqlite.prepare("DELETE FROM exif_data WHERE photo_id = 1").run();
    db.insert(advancedExifData)
      .values({
        photoId: 1,
        captureMode: "portrait",
        normalizedJson: JSON.stringify({ workflow: { artist: "Alice" } }),
      })
      .run();
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    for (const query of [undefined, "mountain", '"fixture-1.jpg"']) {
      const result = await call(searchCompound, {
        query,
        creator: "Alice",
        advancedField: "captureMode",
        advancedValue: "portrait",
      });
      expect(result.results.map((row) => row.id)).toEqual([1]);
    }
  });
  it("reuses a scope across vector writes but refreshes after search metadata changes", async () => {
    const { getPhotoSearchScope } = await import("@/services/search-scope");
    const { getSearchDatabaseRevision, invalidateVectorSearch } = await import(
      "@/services/search-revision"
    );
    const first = getPhotoSearchScope(
      db,
      { isoMin: 100, cameraModel: "Canon" },
      getSearchDatabaseRevision(db, false)
    );
    invalidateVectorSearch();
    const second = getPhotoSearchScope(
      db,
      { cameraModel: "Canon", isoMin: 100 },
      getSearchDatabaseRevision(db, false)
    );
    expect(second).toBe(first);
    sqlite.prepare("UPDATE exif_data SET iso = 50 WHERE photo_id = 1").run();
    const changed = getPhotoSearchScope(
      db,
      { cameraModel: "Canon", isoMin: 100 },
      getSearchDatabaseRevision(db, false)
    );
    expect(changed.key).not.toBe(first.key);
    expect(changed.allowedPhotoIds).toEqual([]);
  });
  it("completes quoted exact searches without requesting visual inference", async () => {
    state.coverage = "unavailable";
    const tag = db.insert(tags).values({ name: "ExactName" }).returning().get();
    db.insert(photoTags)
      .values({ photoId: 1, tagId: tag.id, origin: "manual" })
      .run();
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    const match = await call(searchCompound, { query: '"ExactName"' });
    expect(match.completion).toBe("complete");
    expect(match.results.map((row) => row.id)).toEqual([1]);
    const empty = await call(searchCompound, { query: "“不存在的名字”" });
    expect(empty).toMatchObject({ results: [], completion: "complete" });
    expect(state.search).not.toHaveBeenCalled();
    const mixed = await call(searchCompound, {
      query: '"ExactName" on a mountain',
    });
    expect(mixed.completion).toBe("partial");
  });
  it("keeps a frozen cursor and hydrated thumbnails after display-only writes", async () => {
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    const first = await call(searchCompound, { query: "mountain", limit: 1 });
    sqlite
      .prepare(
        "UPDATE photos SET thumbnail_path = 'fresh.webp', width = 999 WHERE id = 1"
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO app_settings(key, value, updated_at) VALUES('display', 'dark', 1)"
      )
      .run();
    const next = await call(searchCompound, {
      query: "mountain",
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });
    expect(next.cursorExpired).not.toBe(true);
    expect(next.results).toHaveLength(1);
    expect(next.results[0]).toMatchObject({
      id: 1,
      thumbnailPath: "fresh.webp",
      width: 999,
    });
    expect(
      [...first.results, ...next.results].map((row) => row.id).sort()
    ).toEqual([1, 2]);
  });
  it("retains search results while thumbnails are written", async () => {
    const originalSearch = state.search.getMockImplementation();
    state.search.mockImplementation(async (...args) => {
      const result = await originalSearch?.(...args);
      sqlite
        .prepare("UPDATE photos SET thumbnail_path = 'fresh.webp' WHERE id = 1")
        .run();
      return result;
    });
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    const result = await call(searchCompound, { query: "mountain" });
    expect(result.completion).toBe("complete");
    expect(result.results).toHaveLength(2);
  });
  it("rejects results if a search field changes during recall", async () => {
    const originalSearch = state.search.getMockImplementation();
    state.search.mockImplementation(async (...args) => {
      const result = await originalSearch?.(...args);
      sqlite.prepare("UPDATE exif_data SET iso = 50 WHERE photo_id = 2").run();
      return result;
    });
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    const result = await call(searchCompound, {
      query: "mountain",
      isoMin: 800,
    });
    expect(result).toMatchObject({
      results: [],
      completion: "partial",
      incompleteReason: "changed",
    });
  });
  it("expires person cursors and replaces exact-name evidence after a rename", async () => {
    state.coverage = "unavailable";
    const person = db
      .insert(faceIdentities)
      .values({ name: "PersonAlpha" })
      .returning()
      .get();
    for (const photoId of [1, 2]) {
      const face = db
        .insert(faceVectors)
        .values({
          photoId,
          bboxX: 0,
          bboxY: 0,
          bboxWidth: 1,
          bboxHeight: 1,
        })
        .returning()
        .get();
      db.insert(faceIdentityMembers)
        .values({
          identityId: person.id,
          faceVectorId: face.id,
        })
        .run();
    }
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    const first = await call(searchCompound, {
      query: "PersonAlpha",
      limit: 1,
    });
    expect(first.nextCursor).toBeTruthy();
    sqlite
      .prepare("UPDATE face_identities SET name = ? WHERE id = ?")
      .run("PersonBeta", person.id);
    const stale = await call(searchCompound, {
      query: "PersonAlpha",
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });
    expect(stale).toMatchObject({ cursorExpired: true, results: [] });
    expect(
      (await call(searchCompound, { query: "PersonAlpha" })).results
    ).toEqual([]);
    const fresh = await call(searchCompound, {
      query: "PersonBeta",
      cameraModel: "Nikon",
    });
    expect(fresh.results.map((row) => row.id)).toEqual([2]);
  });
  it("returns filtered filename results when semantic indexing is unavailable", async () => {
    state.coverage = "unavailable";
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    const result = await call(searchCompound, {
      query: "fixture",
      cameraModel: "Nikon",
    });
    expect(result.results.map((row) => row.id)).toEqual([2]);
    expect(result).toMatchObject({
      completion: "partial",
      incompleteReason: "semantic-unavailable",
      totalExact: false,
    });
  });
  it.each([
    "日照金山",
    "拍立得",
    "过山车",
  ])("preserves visual word %s", (word) => {
    expect(rewriteQuery(`帮我找一下${word}的照片`).cleanQuery).toBe(word);
  });
  it("separates time without deleting characters in the remaining description", () => {
    const plan = rewriteQuery("帮我找去年夏天拍的海边照片");
    expect(plan.cleanQuery).toBe("海边");
    expect(plan.timeFilter).toBeDefined();
  });
  it("never substitutes the auxiliary score for the whole-query score", () => {
    const fused = fuseRankedSearchEvidence(
      [[], [{ photoId: 1, similarity: 0.9 }]],
      10,
      [1, 0.5],
      ["whole-query", "subject"],
      0
    );
    expect(fused[0].primarySimilarity).toBe(0);
  });
  it("prefilters vector recall with all hard conditions and active records", async () => {
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    const result = await call(searchCompound, {
      query: "mountain",
      isoMin: 800,
      cameraModel: "Nikon",
      dateFrom: 100,
      dateTo: 200,
    });
    expect(state.search.mock.calls[0][2].allowedPhotoIds).toEqual([2]);
    expect(result.results.map((row) => row.id)).toEqual([2]);
  });
  it("uses the same hard filters and stable pagination for filename wildcards", async () => {
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    const filtered = await call(searchCompound, {
      query: "fixture-*.jpg",
      isoMin: 800,
      cameraModel: "Nikon",
      limit: 1,
    });
    expect(filtered.results.map((row) => row.id)).toEqual([2]);
    const first = await call(searchCompound, {
      query: "fixture-*.jpg",
      limit: 1,
    });
    const second = await call(searchCompound, {
      query: "fixture-*.jpg",
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });
    expect([...first.results, ...second.results].map((row) => row.id)).toEqual([
      2, 1,
    ]);
    expect(second.hasMore).toBe(false);
    expect(state.search).not.toHaveBeenCalled();
  });
  it("retains scored partial candidates when the remaining budget is exhausted", async () => {
    const { SearchInterrupted } = await import("@/services/search-control");
    state.search.mockImplementation((_q, _limit, options) => {
      options.onCandidates({
        results: [
          {
            photoId: 2,
            similarity: 0.8,
            primarySimilarity: 0.8,
            rankScore: 0.1,
          },
        ],
        hasMore: true,
        strongCutoff: 0.1,
        supportCutoff: 0.05,
        plan: {
          prompts: [{ text: "mountain" }],
          intent: "scene",
          language: "en",
        },
      });
      return Promise.reject(new SearchInterrupted("deadline"));
    });
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    const result = await call(searchCompound, {
      query: "mountain",
      isoMin: 800,
    });
    expect(result.results.map((row) => row.id)).toEqual([2]);
    expect(result).toMatchObject({
      completion: "partial",
      incompleteReason: "deadline",
      totalExact: false,
      hasMore: true,
    });
  });
  it("does not loosen a visual query into a date-only query", async () => {
    state.search.mockResolvedValue({
      results: [],
      hasMore: false,
      plan: { prompts: [], language: "en" },
    });
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    const result = await call(searchCompound, {
      query: "astronaut",
      dateFrom: 100,
      dateTo: 200,
      cameraModel: "Nikon",
    });
    expect(result.results).toEqual([]);
    expect(result.totalExact).toBe(true);
  });
  it("rejects deleted or missing AI candidates at the final result boundary", async () => {
    state.search.mockResolvedValue({
      results: [3, 999].map((photoId) => ({
        photoId,
        similarity: 0.9,
        primarySimilarity: 0.9,
        rankScore: 1,
      })),
      plan: { prompts: [], language: "en" },
    });
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    expect((await call(searchCompound, { query: "mountain" })).results).toEqual(
      []
    );
  });
  it("invalidates a frozen cursor after metadata or deletion changes", async () => {
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    const first = await call(searchCompound, { query: "mountain", limit: 1 });
    expect(first.nextCursor).toBeTruthy();
    sqlite.prepare("UPDATE photos SET deleted_at = 1 WHERE id = 2").run();
    const next = await call(searchCompound, {
      query: "mountain",
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });
    expect(next.cursorExpired).toBe(true);
    expect(next.results).toEqual([]);
  });
  it("includes restored records in a new search and expires the previous cursor", async () => {
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    const first = await call(searchCompound, { query: "mountain", limit: 1 });
    sqlite.prepare("UPDATE photos SET deleted_at = NULL WHERE id = 3").run();
    const stale = await call(searchCompound, {
      query: "mountain",
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });
    expect(stale.cursorExpired).toBe(true);
    const fresh = await call(searchCompound, { query: "mountain" });
    expect(fresh.results.map((row) => row.id).sort()).toEqual([1, 2, 3]);
  });
  it("returns incomplete status when semantic recall fails, retaining hard conditions", async () => {
    state.search.mockRejectedValue(new Error("failed"));
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    const result = await call(searchCompound, {
      query: "fixture",
      isoMin: 800,
    });
    expect(result.results.map((row) => row.id)).toEqual([2]);
    expect(result.completion).toBe("partial");
    expect(result.totalExact).toBe(false);
  });
});
