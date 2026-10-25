import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { os } from "@orpc/server";
import type { SQL } from "drizzle-orm";
import { and, desc, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDatabase } from "@/db";
import {
  faceIdentities,
  faceIdentityMembers,
  faceVectors,
  photos,
  photoTags,
  tags,
} from "@/db/schema";
import { ipcContext } from "@/ipc/context";
import { getAiReadiness } from "@/services/ai/health";
import {
  extractTemporalContext,
  parseChineseQuery,
} from "@/services/ai/query-parser";
import {
  getActiveSearchSensitivity,
  getSensitivityMultiplier,
} from "@/services/ai/search-sensitivity";
import { extractNegativeClauses } from "@/services/ai/semantic-query-plan";
import { getTranslationState } from "@/services/ai/translation-worker-client";
import {
  searchByImage as aiSearchByImage,
  searchByText as aiSearchByText,
  searchByTextWithPlan as aiSearchByTextWithPlan,
  isAiSearchReady,
} from "@/services/ai-embedder";
import { createImageSearchPreview } from "@/services/image-search-preview";
import type { RewrittenQuery } from "@/services/query-rewrite";
import { rewriteQuery, timeFilterToDateRange } from "@/services/query-rewrite";
import {
  buildTagSearchEvidence,
  type ExactSearchEvidence,
  fuseGatedHybridSearchEvidence,
  fuseHybridSearchEvidence,
  type GatedHybridResult,
  type HybridSearchResult,
} from "@/services/rerank";
import {
  beginSearchRequest,
  cancelSearchRequest,
  checkSearch,
  createSearchDiagnostics,
  measureSearch,
  type SearchExecution,
  SearchInterrupted,
  waitForSearch,
} from "@/services/search-control";
import { traceSearchQuality } from "@/services/search-quality-trace";
import {
  getSearchDatabaseRevision,
  getVectorSearchRevision,
} from "@/services/search-revision";
import {
  buildPhotoSearchScope,
  getPhotoSearchScope,
  type PhotoSearchFilters,
} from "@/services/search-scope";
import {
  appendToFrozenSearchPool,
  createSearchFingerprint,
  SearchSessionStore,
  takeFrozenSearchPage,
} from "@/services/search-session";
import { getTagSearchRevision } from "@/services/tag-search-revision";
import type { SearchMatch, SearchResponse } from "@/types/photo";
import {
  COLOR_MATCH_MAX_DISTANCE_SQUARED,
  colorDistanceToMatchScore,
  mergeColorSearchRanks,
} from "@/utils/color-search";
import {
  applyTimeDecay,
  CompoundSearchSchema,
  deferSearchBranch,
  ImageSearchPreviewSchema,
  ImageSearchSchema,
  SearchSchema,
} from "./shared";

export const getImageSearchPreview = os
  .input(ImageSearchPreviewSchema)
  .handler(async ({ input }) => createImageSearchPreview(input.imagePath));

// ── Lightweight field selection for search results ───────────────────
// Excludes heavy columns (phash, contentHash, vectorId, duelPreviewPath)
// that are never needed in search result lists, saving ~150+ bytes/photo.
const SEARCH_PHOTO_COLUMNS = {
  id: photos.id,
  path: photos.path,
  folderId: photos.folderId,
  filename: photos.filename,
  fileSize: photos.fileSize,
  fileDate: photos.fileDate,
  width: photos.width,
  height: photos.height,
  format: photos.format,
  colorSpace: photos.colorSpace,
  hasAlpha: photos.hasAlpha,
  thumbnailPath: photos.thumbnailPath,
  thumbnailSize: photos.thumbnailSize,
  dominantColors: photos.dominantColors,
  colorBucket: photos.colorBucket,
  isIndexed: photos.isIndexed,
  isAiProcessed: photos.isAiProcessed,
  isFaceProcessed: photos.isFaceProcessed,
  isFavorite: photos.isFavorite,
  deletedAt: photos.deletedAt,
  createdAt: photos.createdAt,
};

// Pre-compiled regex patterns for color search and temporal detection
const HASH_PREFIX_RE = /^#/;
const HEX_COLOR_RE = /^([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;
const HEX_COLOR_QUERY_RE = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;
const MAX_RGB_DISTANCE_SQUARED = 3 * 255 ** 2;
const CHINESE_CHAR_RE = /[一-鿿]/;
const GLOB_WILDCARD_RE = /[*?[]/;
const EXACT_NAME_RE = /["“][^"”]+["”]/g;
const QUOTED_NAME_RE = /["“][^"”]+["”]/;

function needsVectorRevision(
  input: z.output<typeof CompoundSearchSchema>
): boolean {
  let text = input.query?.trim() ?? "";
  if (input.colorHex || HEX_COLOR_QUERY_RE.test(text)) {
    return true;
  }
  if (!QUOTED_NAME_RE.test(text) && GLOB_WILDCARD_RE.test(text)) {
    return false;
  }
  if (CHINESE_CHAR_RE.test(text)) {
    text = rewriteQuery(text).cleanQuery.trim();
  }
  return Boolean(text.replace(EXACT_NAME_RE, "").trim());
}

function isExactSource(
  source: string
): source is "person" | "tag" | "filename" {
  return ["person", "tag", "filename"].includes(source);
}

function toSearchMatch(
  result: GatedHybridResult | HybridSearchResult
): SearchMatch {
  if ("hybridEvidence" in result) {
    if (result.hybridEvidence.length > 0) {
      return {
        kind: "hybrid",
        evidence: result.hybridEvidence,
        tagNames: result.tagNames,
        ...(result.hybridEvidence.includes("semantic")
          ? { score: result.similarity }
          : {}),
      };
    }
    return isExactSource(result._source)
      ? { kind: "exact", source: result._source }
      : { kind: "semantic", score: result.similarity };
  }
  return result._source === "ai" || result._source === "autoTag"
    ? { kind: "semantic", score: result.similarity }
    : { kind: "exact", source: result._source };
}

function withoutInternalSearchScores<
  T extends {
    exactMatch?: boolean;
    rankScore?: number;
    score?: number;
    similarity?: number;
  },
>(
  results: T[]
): Omit<T, "exactMatch" | "rankScore" | "score" | "similarity">[] {
  return results.map(
    ({
      exactMatch: _exactMatch,
      rankScore: _rankScore,
      score: _score,
      similarity: _similarity,
      ...result
    }) => result
  );
}

// ── 熔断与超时配置 ──────────────────────────────────────────────────
const AI_SEARCH_TIMEOUT_MS = 2000;
const AI_SEARCH_COLD_TIMEOUT_MS = 10_000;
const COLOR_VECTOR_TIMEOUT_MS = 250;
const SEARCH_PIPELINE_VERSION =
  process.env.AI_SEARCH_PIPELINE === "v2" ? "v2" : "hybrid-v3";

const searchSessions = new SearchSessionStore();
const _SQLITE_LIKE_TIMEOUT_MS = 5000; // SQLite LIKE 查询软超时（已有 busy_timeout=5000）

// EXIF filter cache: cache key -> { result, timestamp }
export interface CachedSearchResult {
  hasMore?: boolean;
  nextOffset?: number | null;
  results: Array<{ id: number }>;
  total: number;
  totalExact?: boolean;
}

const filterCache = new Map<
  string,
  { result: CachedSearchResult; timestamp: number }
>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 50;
const FTS5_QUOTE_RE = /["]/;
const WHITESPACE_RE = /\s+/g;
const WHITESPACE_SPLIT_RE = /\s+/;
const NAME_SPLIT_RE = /\s+|[，,。]/;

function getCacheKey(params: Record<string, unknown>): string {
  // Create a deterministic key excluding non-filter params
  const filterParams: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && key !== "query" && key !== "requestId") {
      filterParams[key] = value;
    }
  }
  return JSON.stringify(filterParams, Object.keys(filterParams).sort());
}

function getCachedResult(cacheKey: string) {
  const entry = filterCache.get(cacheKey);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) {
    return entry.result;
  }
  if (entry) {
    filterCache.delete(cacheKey); // expired
  }
  return null;
}

function setCachedResult(cacheKey: string, result: CachedSearchResult) {
  // Evict oldest if at capacity
  if (filterCache.size >= MAX_CACHE_SIZE) {
    const firstKey = filterCache.keys().next().value;
    if (firstKey !== undefined) {
      filterCache.delete(firstKey);
    }
  }
  filterCache.set(cacheKey, { result, timestamp: Date.now() });
}

// AI Search
export const searchByText = os
  .input(SearchSchema)
  .handler(async ({ input }) => {
    const db = getDatabase();
    const results = await aiSearchByText(input.query, input.limit);

    const photoIds = results.map((r) => r.photoId);
    if (photoIds.length === 0) {
      return { results: [], query: input.query };
    }

    const photoList = db
      .select(SEARCH_PHOTO_COLUMNS)
      .from(photos)
      .where(and(isNull(photos.deletedAt), inArray(photos.id, photoIds)))
      .all();

    const photoMap = new Map(photoList.map((p) => [p.id, p]));
    const merged = results
      .map((r) => {
        const photo = photoMap.get(r.photoId);
        if (!photo) {
          return null;
        }
        return {
          ...photo,
          match: { kind: "semantic" as const, score: r.similarity },
          similarity: r.similarity,
          fileDate: photo.fileDate,
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null && p.id != null);

    // Extract temporal boost from query if it contains time keywords
    const hasChinese = CHINESE_CHAR_RE.test(input.query);
    let temporalBoost: ReturnType<typeof extractTemporalContext> | undefined;
    if (hasChinese) {
      const parsed = parseChineseQuery(input.query);
      temporalBoost = extractTemporalContext(parsed);
    }

    const scored = applyTimeDecay(merged, { temporalBoost });
    return {
      results: withoutInternalSearchScores(scored),
      query: input.query,
    };
  });

export const searchByImage = os
  .input(ImageSearchSchema)
  .handler(async ({ input }) => {
    const db = getDatabase();
    // Verify the image file exists before attempting AI search
    if (!fs.existsSync(input.imagePath)) {
      return {
        results: [],
        error: "图片文件不存在",
        errorCode: "SOURCE_NOT_FOUND" as const,
      };
    }

    let results: Array<{ photoId: number; similarity: number }> = [];
    try {
      results = await aiSearchByImage(input.imagePath, input.limit);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[searchByImage] AI search failed:", message);
      return {
        results: [],
        error: `AI 搜索失败: ${message || "未知错误"}`,
        errorCode: "AI_SEARCH_FAILED" as const,
      };
    }

    const photoIds = results.map((r) => r.photoId);
    if (photoIds.length === 0) {
      return {
        results: [],
        error: "未找到相似图片（请确认 AI 模型已就绪且图片已索引）",
        errorCode: "NO_MATCHES" as const,
      };
    }

    const photoList = db
      .select(SEARCH_PHOTO_COLUMNS)
      .from(photos)
      .where(and(isNull(photos.deletedAt), inArray(photos.id, photoIds)))
      .all();

    const photoMap = new Map(photoList.map((p) => [p.id, p]));
    const merged = results
      .map((r) => {
        const photo = photoMap.get(r.photoId);
        if (!photo) {
          return null;
        }
        return {
          ...photo,
          match: { kind: "image" as const, score: r.similarity },
          similarity: r.similarity,
          fileDate: photo.fileDate,
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null && p.id != null);

    const scored = applyTimeDecay(merged);
    return { results: withoutInternalSearchScores(scored) };
  });

// ── 超时包装器 ──────────────────────────────────────────────────────
// 为异步操作添加硬超时，超时后自动 Reject，
// 与 Promise.allSettled 配合使用实现优雅降级。

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  if (timeoutMs <= 0) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[Timeout] ${label} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

// ── 从时间过滤器中构建 temporalBoost ───────────────────────────────
// 自动补全不完整的时间边界（如 "今年" 只有 from，补 to=Date.now()）

function _buildTemporalBoost(
  dateFrom?: number,
  dateTo?: number
): { targetFrom: number; targetTo: number; factor: number } | undefined {
  if (dateFrom == null && dateTo == null) {
    return undefined;
  }
  const now = Date.now();
  const from = dateFrom ?? 0;
  const to = dateTo ?? now;
  // 根据时间窗口跨度选择 factor
  const spanMs = to - from;
  const oneDay = 24 * 60 * 60 * 1000;
  let factor: number;
  if (spanMs <= oneDay) {
    factor = 1.5; // 1天内 → 高提权
  } else if (spanMs <= 7 * oneDay) {
    factor = 1.4; // 1周内
  } else if (spanMs <= 31 * oneDay) {
    factor = 1.3; // 1月内
  } else {
    factor = 1.2; // 更长时间窗口
  }
  return { targetFrom: from, targetTo: to, factor };
}

// Compound search: text + EXIF filters
interface CompoundSearchExecution extends SearchExecution {
  /** The response was finalized in a synchronous SQLite read snapshot. */
  snapshotValidated?: boolean;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Compound search coordinates independent search branches and ranking.
async function performCompoundSearch(
  input: z.output<typeof CompoundSearchSchema>,
  execution: CompoundSearchExecution,
  sourceRevision: string
) {
  const db = getDatabase();
  const {
    query,
    colorHex,
    dateFrom,
    dateMonth,
    dateHour,
    dateTo,
    cameraModel,
    lensModel,
    creator,
    advancedField,
    advancedValue,
    focalMin,
    focalMax,
    apertureMin,
    apertureMax,
    isoMin,
    isoMax,
    shutterMin,
    shutterMax,
    cursor,
    limit,
    offset,
  } = input;
  checkSearch(execution);
  const vectorRevision = getVectorSearchRevision();
  const sqliteBranch = <T>(task: () => T) =>
    deferSearchBranch(() => measureSearch(execution, "sqliteMs", task));
  const hydratePage = <T extends { id: number }>(page: T[]) => {
    if (page.length === 0) {
      return [];
    }
    const started = performance.now();
    const rows = db
      .select(SEARCH_PHOTO_COLUMNS)
      .from(photos)
      .where(
        and(
          isNull(photos.deletedAt),
          inArray(
            photos.id,
            page.map((row) => row.id)
          )
        )
      )
      .all();
    const byId = new Map(rows.map((row) => [row.id, row]));
    if (execution.diagnostics) {
      execution.diagnostics.timings.hydrationMs =
        (execution.diagnostics.timings.hydrationMs ?? 0) +
        performance.now() -
        started;
    }
    return page.flatMap((row) => {
      const photo = byId.get(row.id);
      return photo ? [{ ...row, ...photo }] : [];
    });
  };
  const activeSensitivity = getActiveSearchSensitivity();
  const fingerprint = createSearchFingerprint({
    ...input,
    sensitivity: activeSensitivity,
    tagRevision: query?.trim() ? getTagSearchRevision() : undefined,
    sourceRevision,
  });
  const activeSearchSession = cursor ? searchSessions.get(cursor) : null;
  const expireCursor = () => {
    if (cursor) {
      searchSessions.delete(cursor);
    }
    return {
      cursorExpired: true,
      hasMore: false,
      nextCursor: null,
      nextOffset: null,
      results: [],
      snapshotVersion: activeSearchSession?.snapshotVersion,
      total: 0,
      totalExact: false,
      completion: "partial" as const,
      incompleteReason: "changed" as const,
    };
  };
  if (
    cursor &&
    (!activeSearchSession || activeSearchSession.fingerprint !== fingerprint)
  ) {
    return expireCursor();
  }
  if (
    activeSearchSession?.responseBase &&
    (activeSearchSession.rankedPool.length >= limit ||
      (activeSearchSession.rankedPool.length > 0 &&
        !activeSearchSession.upstreamHasMore))
  ) {
    const responseBase = activeSearchSession.responseBase;
    return db.transaction(() => {
      if (
        getSearchDatabaseRevision(db, needsVectorRevision(input)) !==
        sourceRevision
      ) {
        execution.snapshotValidated = true;
        return expireCursor();
      }
      if (execution.signal?.aborted) {
        throw new SearchInterrupted("cancelled");
      }
      const page = takeFrozenSearchPage(activeSearchSession, limit);
      for (const result of page) {
        activeSearchSession.emittedIds.add(result.id);
      }
      const hasMore =
        activeSearchSession.upstreamHasMore ||
        activeSearchSession.rankedPool.length > 0;
      const cachedSemantic = responseBase.semantic;
      execution.snapshotValidated = true;
      return {
        ...responseBase,
        hasMore,
        nextCursor: hasMore ? activeSearchSession.cursor : null,
        nextOffset: hasMore ? activeSearchSession.emittedIds.size : null,
        results: hydratePage(page),
        ...(cachedSemantic &&
        typeof cachedSemantic === "object" &&
        !Array.isArray(cachedSemantic)
          ? {
              semantic: {
                ...cachedSemantic,
                searchSessionHit: true,
              },
            }
          : {}),
        snapshotVersion: activeSearchSession.snapshotVersion,
      };
    });
  }
  const effectiveOffset = activeSearchSession?.candidateDepth ?? offset;
  const resultWindowEnd = activeSearchSession
    ? Math.max(effectiveOffset + limit, effectiveOffset * 2)
    : offset + limit;
  const requestedCandidateDepth = activeSearchSession
    ? Math.max(200, activeSearchSession.candidateDepth * 2)
    : 200;
  let searchSessionTagEvidence: unknown;
  const finalizeSearchPage = <
    T extends { id: number } & Record<string, unknown>,
    R extends Record<string, unknown>,
  >(
    allResults: T[],
    base: R,
    upstreamHasMore: boolean,
    candidateDepth = resultWindowEnd,
    retainSession = true
  ) => {
    if (!retainSession) {
      return {
        ...base,
        results: hydratePage(allResults.slice(offset, offset + limit)),
        total: allResults.length,
        totalExact: false,
        hasMore: false,
        nextCursor: null,
        nextOffset: null,
      };
    }
    const session =
      activeSearchSession ?? searchSessions.create(fingerprint, candidateDepth);
    appendToFrozenSearchPool(session, allResults);
    if (!activeSearchSession && offset > 0) {
      for (const skipped of takeFrozenSearchPage(session, offset)) {
        session.emittedIds.add(skipped.id);
      }
    }
    const page = takeFrozenSearchPage<T>(session, limit);
    for (const result of page) {
      session.emittedIds.add(result.id);
    }
    session.candidateDepth = candidateDepth;
    session.lastAccess = Date.now();
    session.responseBase = {
      ...base,
      total: session.emittedIds.size + session.rankedPool.length,
    };
    session.tagEvidence ??= searchSessionTagEvidence;
    session.upstreamHasMore = upstreamHasMore;
    const hasMore = upstreamHasMore || session.rankedPool.length > 0;
    return {
      ...session.responseBase,
      hasMore,
      nextCursor: hasMore ? session.cursor : null,
      nextOffset: hasMore ? session.emittedIds.size : null,
      results: hydratePage(page),
      snapshotVersion: session.snapshotVersion,
    };
  };
  // Pre-process: extract time filter from natural language
  let effectiveDateFrom = dateFrom;
  let effectiveDateTo = dateTo;
  let rewrittenTimeFilter: RewrittenQuery["timeFilter"] | undefined;
  let rewrittenQuery: RewrittenQuery | undefined;
  let searchText = query;
  if (searchText?.trim()) {
    const q = searchText.trim();
    if (
      CHINESE_CHAR_RE.test(q) &&
      (QUOTED_NAME_RE.test(q) || !GLOB_WILDCARD_RE.test(q))
    ) {
      const rewritten = rewriteQuery(q);
      rewrittenQuery = rewritten;
      if (
        effectiveDateFrom === undefined &&
        effectiveDateTo === undefined &&
        rewritten.timeFilter
      ) {
        effectiveDateFrom = rewritten.timeFilter.from;
        effectiveDateTo = rewritten.timeFilter.to;
      }
      rewrittenTimeFilter = rewritten.timeFilter;
      // Pure time query → clear searchText, fall through to EXIF-only path
      searchText = rewritten.cleanQuery.trim() || undefined;
    }
  }

  traceSearchQuality("query-rewrite", () => ({
    query,
    searchText,
    rewrittenQuery,
  }));
  const filters: PhotoSearchFilters = {
    dateFrom: effectiveDateFrom,
    dateTo: effectiveDateTo,
    dateMonth,
    dateHour,
    cameraModel,
    lensModel,
    creator,
    advancedField,
    advancedValue,
    focalMin,
    focalMax,
    apertureMin,
    apertureMax,
    isoMin,
    isoMax,
    shutterMin,
    shutterMax,
  };
  const scopePredicate = buildPhotoSearchScope(db, filters);
  const metadataRevision = getSearchDatabaseRevision(db, false);

  // Color search: if colorHex provided, or query is a hex code
  function parseHexColor(
    hex: string
  ): { r: number; g: number; b: number } | null {
    const cleaned = hex.replace(HASH_PREFIX_RE, "");
    const match = HEX_COLOR_RE.exec(cleaned);
    if (!match) {
      return null;
    }
    let h = match[1];
    if (h.length === 3) {
      h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    return {
      r: Number.parseInt(h.slice(0, 2), 16),
      g: Number.parseInt(h.slice(2, 4), 16),
      b: Number.parseInt(h.slice(4, 6), 16),
    };
  }

  let effectiveColorHex = colorHex;
  if (!effectiveColorHex && query?.trim()) {
    const hexMatch = HEX_COLOR_QUERY_RE.exec(query.trim());
    if (hexMatch) {
      effectiveColorHex = hexMatch[1];
    }
  }

  if (effectiveColorHex) {
    const rgb = parseHexColor(effectiveColorHex);
    if (rgb) {
      // SQLite palette matching is authoritative; vector-only candidates
      // are supplementary and must obey the same hard-filter scope.
      const colorScope = getPhotoSearchScope(db, filters, metadataRevision);
      if (colorScope.rows.length === 0) {
        return {
          results: [],
          total: 0,
          totalExact: true,
          hasMore: false,
          ...(rewrittenTimeFilter
            ? { timeFilter: timeFilterToDateRange(rewrittenTimeFilter) }
            : {}),
        };
      }
      const candidates = db
        .select({
          id: photos.id,
          dist: sql<number>`closest_color_dist(${rgb.r}, ${rgb.g}, ${rgb.b}, ${photos.dominantColors})`.as(
            "dist"
          ),
        })
        .from(photos)
        .where(scopePredicate);
      const paletteResults = db.all(
        sql`WITH color_candidates AS MATERIALIZED (${candidates.getSQL()})
          SELECT id, dist FROM color_candidates
          WHERE dist < ${COLOR_MATCH_MAX_DISTANCE_SQUARED}
            OR dist > ${MAX_RGB_DISTANCE_SQUARED}
          ORDER BY dist ASC, id ASC`
      ) as Array<{ dist: number; id: number }>;
      const sqliteResults = paletteResults.filter(
        (row) => row.dist < COLOR_MATCH_MAX_DISTANCE_SQUARED
      );
      // Invalid/absent palettes return Infinity or MAX_VALUE from the UDF.
      // Every valid RGB distance is <= 3 * 255^2. A stale primary-color vector
      // must never override a valid palette that rejects this color.
      const supplementIds = paletteResults
        .filter((row) => row.dist > MAX_RGB_DISTANCE_SQUARED)
        .map((row) => row.id);
      const supplementSet = new Set(supplementIds);
      let lanceResults: Array<{ distanceSquared: number; photoId: number }> =
        [];
      let colorIncomplete = false;
      if (supplementIds.length > 0) {
        try {
          const { searchByColorVector } = await import(
            "@/services/ai/vector-db"
          );
          lanceResults = (
            (await withTimeout(
              searchByColorVector(
                rgb.r,
                rgb.g,
                rgb.b,
                supplementIds.length,
                supplementIds,
                true
              ),
              COLOR_VECTOR_TIMEOUT_MS,
              "ColorVector"
            )) ?? []
          ).filter(
            (result) =>
              result.distanceSquared < COLOR_MATCH_MAX_DISTANCE_SQUARED &&
              supplementSet.has(result.photoId)
          );
        } catch {
          colorIncomplete = true;
        }
      }
      checkSearch(execution);
      const ranks = mergeColorSearchRanks(
        sqliteResults.map((result) => ({
          photoId: result.id,
          distanceSquared: result.dist,
        })),
        lanceResults,
        colorScope.rows.length
      );
      return finalizeSearchPage(
        ranks.map((rank) => ({
          id: rank.photoId,
          match: {
            kind: "color" as const,
            score: colorDistanceToMatchScore(rank.distanceSquared),
          },
        })),
        {
          total: ranks.length,
          totalExact: !colorIncomplete,
          searchMode: "color" as const,
          ...(rewrittenTimeFilter
            ? { timeFilter: timeFilterToDateRange(rewrittenTimeFilter) }
            : {}),
          ...(colorIncomplete
            ? {
                completion: "partial" as const,
                incompleteReason: "semantic-unavailable" as const,
              }
            : {}),
        },
        false
      );
    }
  }

  // Text query: multi-source retrieval → dedup → rerank
  if (searchText?.trim()) {
    const q = searchText.trim();
    const scopeStarted = performance.now();
    const quotedNames = [...q.matchAll(/["“]([^"”]+)["”]/g)].map(
      (match) => match[1]
    );
    const isGlob = quotedNames.length === 0 && GLOB_WILDCARD_RE.test(q);
    const textFilters = { ...filters, filenameGlob: isGlob ? q : undefined };
    const readScope = () =>
      getPhotoSearchScope(
        db,
        textFilters,
        getSearchDatabaseRevision(db, false)
      );
    let scoped = db.transaction(readScope);
    let scopeById = scoped.byId;
    let allowedPhotoIds = scoped.allowedPhotoIds;
    if (execution.diagnostics) {
      execution.diagnostics.timings.sqliteMs = performance.now() - scopeStarted;
    }
    if (execution.signal?.aborted) {
      throw new SearchInterrupted("cancelled");
    }
    if (isGlob || allowedPhotoIds.length === 0) {
      const localPage = db.transaction(() => {
        const changed =
          getSearchDatabaseRevision(db, needsVectorRevision(input)) !==
          sourceRevision;
        scoped = readScope();
        scopeById = scoped.byId;
        allowedPhotoIds = scoped.allowedPhotoIds;
        if (!isGlob && allowedPhotoIds.length > 0) {
          return null;
        }
        execution.snapshotValidated = true;
        if (changed && cursor) {
          return expireCursor();
        }
        const scope = [...scoped.rows].sort(
          (left, right) =>
            (right.fileDate ?? 0) - (left.fileDate ?? 0) || left.id - right.id
        );
        return finalizeSearchPage(
          scope,
          {
            query: q,
            total: scope.length,
            totalExact: !changed,
            semanticRequired: false,
            ...(rewrittenTimeFilter
              ? { timeFilter: timeFilterToDateRange(rewrittenTimeFilter) }
              : {}),
            ...(changed
              ? {
                  completion: "partial" as const,
                  incompleteReason: "changed" as const,
                }
              : {}),
          },
          false,
          resultWindowEnd,
          !changed
        );
      });
      if (localPage) {
        return localPage;
      }
    }
    const semanticRequired = Boolean(q.replace(EXACT_NAME_RE, "").trim());
    let aiReadiness: Awaited<ReturnType<typeof getAiReadiness>> | undefined;
    let semanticAvailable = false;
    let semantic = {
      candidateMinimum: 0,
      candidateDepth: 0,
      consensusCutoff: 0,
      cutoffReason: "not-run",
      finalCutoff: 0,
      hasMore: false,
      indexedPhotos: 0,
      intent: "unknown" as "object" | "scene" | "composed" | "unknown",
      promptGroupCount: 0,
      reason: undefined as string | undefined,
      rejectedWeak: 0,
      state: "unavailable" as Awaited<
        ReturnType<typeof getAiReadiness>
      >["coverageState"],
      strongAccepted: 0,
      strongCutoff: 0,
      sensitivity: activeSensitivity,
      sensitivityMultiplier: getSensitivityMultiplier(activeSensitivity),
      supportedAccepted: 0,
      supportCutoff: 0,
      manualExactAccepted: 0,
      semanticOnlyAccepted: 0,
      tagSupportedAccepted: 0,
      autoTagRescued: 0,
      ignoredLowConfidenceTags: 0,
      topSimilarity: 0,
      totalPhotos: 0,
      required: semanticRequired,
      used: false,
    };

    // ── 提取原始查询中的潜在专有名词 token ─────────────────────
    // 保留完整正向描述和显式分词，不拆解中文词语内部字符。
    const positiveNames = extractNegativeClauses(q).positiveText.replace(
      /[“”"']/g,
      " "
    );
    const nameTokens = [
      ...new Set([
        ...quotedNames,
        ...positiveNames.split(NAME_SPLIT_RE).filter(Boolean),
      ]),
    ];
    const literalQuery = q
      .replace(/[“”"]/g, " ")
      .trim()
      .replace(WHITESPACE_RE, " ");
    const literalContains = (field: Parameters<typeof like>[0], text: string) =>
      sql`${field} LIKE ${`%${text.replace(/[\\%_]/g, "\\$&")}%`} ESCAPE ${"\\"}`;
    // 构建 OR LIKE 条件：column LIKE '%token1%' OR column LIKE '%token2%' ...
    function buildTokenConditions(
      tokens: string[],
      field: Parameters<typeof like>[0],
      fallbackQ: string
    ): SQL[] {
      // 完整描述与独立名称都提供召回证据；是否精确命中由融合阶段判断。
      const conditions: SQL[] = [literalContains(field, fallbackQ)];
      for (const token of tokens) {
        if (token !== fallbackQ) {
          conditions.push(literalContains(field, token));
        }
      }
      return conditions;
    }

    // Keep these synchronous collectors reusable for a changed-data read snapshot.
    const collectTags = () =>
      db
        .select({
          id: photos.id,
          name: tags.name,
          confidence: photoTags.confidence,
          origin: photoTags.origin,
          userConfirmed: photoTags.userConfirmed,
        })
        .from(photos)
        .innerJoin(photoTags, eq(photoTags.photoId, photos.id))
        .innerJoin(tags, eq(tags.id, photoTags.tagId))
        .where(
          and(
            scopePredicate,
            or(...buildTokenConditions(nameTokens, tags.name, literalQuery))
          )
        )
        .all();
    const collectFilenames = () => {
      // Glob queries already took the local path; quotes use literal LIKE.
      if (!FTS5_QUOTE_RE.test(q)) {
        try {
          const terms = q
            .replace(WHITESPACE_RE, " ")
            .split(WHITESPACE_SPLIT_RE)
            .map((term) => `"${term}"*`)
            .join(" ");
          const ftsResults = db.all(
            sql`SELECT photos.id AS id, photos.filename AS filename
              FROM photos_fts JOIN photos ON photos.id = photos_fts.rowid
              WHERE photos_fts MATCH ${terms} AND (${scopePredicate})`
          ) as Array<{ id: number; filename: string }>;
          if (ftsResults.length > 0) {
            return ftsResults;
          }
        } catch {
          // FTS5 syntax error: fall back to literal LIKE.
        }
      }
      return db
        .select({ id: photos.id, filename: photos.filename })
        .from(photos)
        .where(
          and(
            scopePredicate,
            or(
              ...buildTokenConditions(
                quotedNames,
                photos.filename,
                literalQuery
              )
            )
          )
        )
        .all();
    };
    const collectPeople = () =>
      db
        .select({ id: photos.id, name: faceIdentities.name })
        .from(photos)
        .innerJoin(faceVectors, eq(faceVectors.photoId, photos.id))
        .innerJoin(
          faceIdentityMembers,
          eq(faceIdentityMembers.faceVectorId, faceVectors.id)
        )
        .innerJoin(
          faceIdentities,
          eq(faceIdentities.id, faceIdentityMembers.identityId)
        )
        .where(
          and(
            scopePredicate,
            or(
              ...buildTokenConditions(
                nameTokens,
                faceIdentities.name,
                literalQuery
              )
            )
          )
        )
        .all();

    let partialAiSearch:
      | Awaited<ReturnType<typeof aiSearchByTextWithPlan>>
      | undefined;
    let candidateDepth = requestedCandidateDepth;
    const semanticBranch = async () => {
      if (!semanticRequired) {
        return null;
      }
      checkSearch(execution);
      aiReadiness ??= await waitForSearch(
        getAiReadiness({ loadModel: false }),
        execution
      );
      checkSearch(execution);
      semanticAvailable =
        aiReadiness.coverageState === "ready" ||
        aiReadiness.coverageState === "partial";
      if (!semanticAvailable) {
        return null;
      }
      return waitForSearch(
        aiSearchByTextWithPlan(
          input.query?.trim() || q,
          activeSearchSession ? limit : offset + limit,
          {
            ...execution,
            get finished() {
              return execution.finished;
            },
            allowedPhotoIds,
            candidateDepth,
            scopeKey: scoped.key,
            sourceRevision,
            rewritten: rewrittenQuery,
            onCandidates: (partial) => {
              if (
                !(execution.finished || execution.signal?.aborted) &&
                performance.now() < execution.deadline
              ) {
                partialAiSearch = partial;
              }
            },
          }
        ),
        execution
      );
    };
    // AI readiness belongs to the timed semantic branch. Local recall must
    // still settle when the vector lease, initialization or inference stalls.
    for (;;) {
      const settled = await Promise.allSettled([
        semanticBranch(),
        (activeSearchSession?.tagEvidence ?? searchSessionTagEvidence)
          ? Promise.resolve(
              activeSearchSession?.tagEvidence ?? searchSessionTagEvidence
            )
          : sqliteBranch(collectTags),
        sqliteBranch(collectFilenames),
        sqliteBranch(collectPeople),
      ]);

      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Evidence revalidation, fusion and page commit must share a synchronous read snapshot.
      const page = db.transaction(() => {
        if (execution.signal?.aborted) {
          throw new SearchInterrupted("cancelled");
        }
        const changed =
          getSearchDatabaseRevision(db, needsVectorRevision(input)) !==
          sourceRevision;
        if (changed && cursor) {
          execution.snapshotValidated = true;
          return expireCursor();
        }
        if (changed) {
          // Re-read all local evidence in this same snapshot; cached tag
          // evidence and the original scope may no longer justify a hit.
          scoped = readScope();
          scopeById = scoped.byId;
          allowedPhotoIds = scoped.allowedPhotoIds;
          settled[1] = { status: "fulfilled", value: collectTags() };
          settled[2] = { status: "fulfilled", value: collectFilenames() };
          settled[3] = { status: "fulfilled", value: collectPeople() };
        }
        const localBranches = settled.slice(1);
        const localFailure = localBranches.find(
          (branch) => branch.status === "rejected"
        );
        if (
          localFailure?.status === "rejected" &&
          localBranches.every((branch) => branch.status === "rejected")
        ) {
          // An unavailable SQLite store is a search error, rather than an
          // empty partial result attributed to optional semantic inference.
          throw localFailure.reason;
        }
        // 拆解 allSettled 结果，记录降级日志
        let aiSearch =
          settled[0].status === "fulfilled"
            ? (settled[0].value as Awaited<
                ReturnType<typeof aiSearchByTextWithPlan>
              >)
            : (partialAiSearch ?? null);
        if (vectorRevision !== getVectorSearchRevision()) {
          aiSearch = null;
        }
        const aiResults = (aiSearch?.results ?? []).filter((row) =>
          scopeById.has(row.photoId)
        );
        let semanticReason = aiReadiness?.lastError ?? semantic.reason;
        if (settled[0].status === "rejected") {
          semanticReason =
            (settled[0].reason as Error)?.message ?? "semantic-search-failed";
        } else if (
          aiSearch?.plan.translationMode === "dictionary-fallback" &&
          aiSearch.plan.language !== "en"
        ) {
          semanticReason = "advanced-chinese-search-degraded";
        }
        semantic = {
          ...semantic,
          indexedPhotos: aiReadiness?.indexedPhotos ?? 0,
          totalPhotos: aiReadiness?.totalPhotos ?? 0,
          state: aiReadiness?.coverageState ?? "unavailable",
          candidateMinimum: aiSearch?.candidateMinimum ?? 0,
          candidateDepth: aiSearch?.candidateDepth ?? 0,
          consensusCutoff: aiSearch?.consensusCutoff ?? 0,
          cutoffReason: aiSearch?.cutoffReason ?? "not-run",
          finalCutoff: aiSearch?.finalCutoff ?? 0,
          hasMore: aiSearch?.hasMore ?? false,
          intent: aiSearch?.plan.intent ?? "unknown",
          promptGroupCount: aiSearch?.promptGroupCount ?? 0,
          reason: semanticReason,
          rejectedWeak: aiSearch?.rejectedWeak ?? 0,
          strongAccepted: aiSearch?.strongAccepted ?? 0,
          strongCutoff: aiSearch?.strongCutoff ?? 0,
          sensitivity: aiSearch?.sensitivity ?? activeSensitivity,
          sensitivityMultiplier:
            aiSearch?.sensitivityMultiplier ??
            getSensitivityMultiplier(activeSensitivity),
          supportedAccepted: aiSearch?.supportedAccepted ?? 0,
          supportCutoff: aiSearch?.supportCutoff ?? 0,
          topSimilarity: aiSearch?.topSimilarity ?? 0,
          used:
            semanticAvailable &&
            settled[0].status === "fulfilled" &&
            (aiSearch?.plan.prompts.length ?? 0) > 0,
        };
        const tagPhotoRows =
          settled[1].status === "fulfilled"
            ? (settled[1].value as Array<{
                confidence: number | null;
                id: number;
                name: string;
                origin: "manual" | "auto";
                userConfirmed: boolean;
              }>)
            : [];
        const allowedTagRows = tagPhotoRows.filter((row) =>
          scopeById.has(row.id)
        );
        searchSessionTagEvidence = allowedTagRows;
        const filenamePhotoRows =
          settled[2].status === "fulfilled"
            ? (settled[2].value as { id: number; filename?: string }[])
            : [];
        const personPhotoRows =
          settled[3].status === "fulfilled"
            ? (settled[3].value as { id: number; name: string }[])
            : [];

        if (settled[0].status === "rejected") {
          console.warn(
            `[Search] AI semantic recall degraded: ${settled[0].reason?.message ?? "timeout"}. Proceeding with SQLite-only results.`
          );
        }
        if (settled[1].status === "rejected") {
          console.warn(
            "[Search] Tag search degraded:",
            settled[1].reason?.message
          );
        }
        if (settled[2].status === "rejected") {
          console.warn(
            "[Search] Filename search degraded:",
            settled[2].reason?.message
          );
        }
        if (settled[3].status === "rejected") {
          console.warn(
            "[Search] Person search degraded:",
            settled[3].reason?.message
          );
        }

        const rankingStarted = performance.now();
        const normalizedExactQuery = q
          .trim()
          .replace(/^[“"]|[”"]$/g, "")
          .toLocaleLowerCase();
        const isFullMatch = (value: string): boolean => {
          const normalized = value.trim().toLocaleLowerCase();
          return (
            normalized === normalizedExactQuery ||
            quotedNames.some(
              (name) => name.trim().toLocaleLowerCase() === normalized
            )
          );
        };
        const semanticPhotoIds = new Set(
          aiResults.map(({ photoId }) => photoId)
        );
        const semanticCandidates =
          SEARCH_PIPELINE_VERSION === "hybrid-v3"
            ? [
                ...aiResults,
                ...(aiSearch?.supportCandidates ?? []).filter(
                  (candidate) => !semanticPhotoIds.has(candidate.photoId)
                ),
              ]
            : aiResults;
        const exactEvidence: ExactSearchEvidence[] = [
          ...personPhotoRows
            .filter((row) => scopeById.has(row.id))
            .map((row) => ({
              exact: isFullMatch(row.name),
              photoId: row.id,
              source: "person" as const,
            })),
          ...buildTagSearchEvidence(
            allowedTagRows,
            SEARCH_PIPELINE_VERSION === "hybrid-v3"
              ? new Set<number>()
              : semanticPhotoIds,
            isFullMatch
          ),
          ...filenamePhotoRows
            .filter((row) => scopeById.has(row.id))
            .map((row) => ({
              exact: isFullMatch(row.filename ?? ""),
              photoId: row.id,
              source: "filename" as const,
            })),
        ];
        const gated =
          SEARCH_PIPELINE_VERSION === "hybrid-v3"
            ? fuseGatedHybridSearchEvidence(
                semanticCandidates,
                exactEvidence,
                allowedTagRows,
                {
                  acceptedSemanticPhotoIds: semanticPhotoIds,
                  intent: aiSearch?.plan.intent ?? "unknown",
                  promptGroupCount: aiSearch?.promptGroupCount ?? 0,
                  strongCutoff: aiSearch?.strongCutoff ?? 0,
                  supportCutoff: aiSearch?.supportCutoff ?? 0,
                  topSimilarity: aiSearch?.topSimilarity ?? 0,
                }
              )
            : null;
        const rerankedList =
          gated?.results ??
          fuseHybridSearchEvidence(
            aiResults,
            exactEvidence,
            aiResults.length + exactEvidence.length
          );
        if (gated) {
          semantic = { ...semantic, ...gated.diagnostics };
          console.log(
            `[Search] pipeline=hybrid-v3 manualExact=${gated.diagnostics.manualExactAccepted} semanticOnly=${gated.diagnostics.semanticOnlyAccepted} tagSupported=${gated.diagnostics.tagSupportedAccepted} autoRescued=${gated.diagnostics.autoTagRescued} ignoredLowConfidenceTags=${gated.diagnostics.ignoredLowConfidenceTags}`
          );
        }

        traceSearchQuality("hybrid-ranking", () => ({
          semanticCandidates,
          exactEvidence,
          tagEvidence: allowedTagRows,
          results: rerankedList,
          diagnostics: gated?.diagnostics,
        }));
        const combined = rerankedList.flatMap((result) => {
          const photo = scopeById.get(result.photoId);
          return photo
            ? [
                {
                  ...photo,
                  exactMatch: result.exact,
                  match: toSearchMatch(result),
                  rankScore: result.rankScore,
                  similarity: result.similarity,
                },
              ]
            : [];
        });
        combined.sort(
          (left, right) =>
            Number(right.exactMatch) - Number(left.exactMatch) ||
            right.rankScore - left.rankScore ||
            right.similarity - left.similarity ||
            (right.fileDate ?? 0) - (left.fileDate ?? 0) ||
            left.id - right.id
        );
        if (execution.diagnostics) {
          execution.diagnostics.timings.rankingMs =
            (execution.diagnostics.timings.rankingMs ?? 0) +
            performance.now() -
            rankingStarted;
        }
        const failed = settled.find((branch) => branch.status === "rejected");
        let incompleteReason: SearchResponse["incompleteReason"] =
          failed || (semanticRequired && !semanticAvailable)
            ? "semantic-unavailable"
            : undefined;
        if (
          failed?.status === "rejected" &&
          failed.reason instanceof SearchInterrupted
        ) {
          incompleteReason = failed.reason.reason;
        }
        if (
          aiSearch &&
          ([
            "model-load-failed",
            "ai-not-initialized",
            "missing-primary-query",
            "missing-negative-query",
            "missing-photo-vector",
          ].includes(aiSearch.cutoffReason) ||
            aiSearch.cutoffReason?.startsWith("vector-"))
        ) {
          incompleteReason = "semantic-unavailable";
        }
        if (performance.now() >= execution.deadline) {
          incompleteReason = "deadline";
        }
        if (changed) {
          incompleteReason = "changed";
        }
        const emitted = activeSearchSession?.emittedIds ?? new Set<number>();
        const availableIds = new Set([
          ...(activeSearchSession?.rankedPool.map((row) => row.id) ?? []),
          ...combined
            .filter((row) => !emitted.has(row.id))
            .map((row) => row.id),
        ]);
        const actualDepth = aiSearch?.candidateDepth ?? candidateDepth;
        if (
          !incompleteReason &&
          aiSearch?.hasMore &&
          availableIds.size < (activeSearchSession ? limit : offset + limit) &&
          actualDepth < allowedPhotoIds.length
        ) {
          candidateDepth = Math.min(
            allowedPhotoIds.length,
            Math.max(actualDepth + 200, actualDepth * 2)
          );
          return null;
        }
        execution.snapshotValidated = true;
        return finalizeSearchPage(
          withoutInternalSearchScores(combined),
          {
            query: q,
            semanticRequired,
            total: combined.length,
            totalExact: !(incompleteReason || aiSearch?.hasMore),
            completion: incompleteReason
              ? ("partial" as const)
              : ("complete" as const),
            ...(incompleteReason ? { incompleteReason } : {}),
            semantic: {
              ...semantic,
              searchSessionHit: Boolean(activeSearchSession),
            },
            ...(rewrittenTimeFilter
              ? { timeFilter: timeFilterToDateRange(rewrittenTimeFilter) }
              : {}),
          },
          Boolean(aiSearch?.hasMore),
          actualDepth,
          !changed
        );
      });
      if (page) {
        return page;
      }
    }
  }

  // No text query: EXIF-only filter
  // Check EXIF-only filter cache (only for non-AI path)
  const cacheKey =
    sourceRevision +
    ":" +
    getCacheKey({ ...input, effectiveDateFrom, effectiveDateTo });
  const cached = getCachedResult(cacheKey);
  if (cached) {
    return {
      ...cached,
      results: hydratePage(cached.results),
      ...(rewrittenTimeFilter
        ? { timeFilter: timeFilterToDateRange(rewrittenTimeFilter) }
        : {}),
    };
  }

  const matchingPhotos = scopePredicate;
  const result = db.transaction(() => {
    const total =
      db
        .select({ count: sql<number>`count(*)` })
        .from(photos)
        .where(matchingPhotos)
        .get()?.count ?? 0;
    const photoList = db
      .select(SEARCH_PHOTO_COLUMNS)
      .from(photos)
      .where(matchingPhotos)
      .orderBy(desc(photos.fileDate), desc(photos.id))
      .limit(limit)
      .offset(offset)
      .all();
    const hasMore = offset + photoList.length < total;
    return {
      results: photoList,
      total,
      totalExact: true,
      hasMore,
      nextOffset: hasMore ? offset + photoList.length : null,
    };
  });
  setCachedResult(cacheKey, {
    ...result,
    results: result.results.map(({ id }) => ({ id })),
  });
  return {
    ...result,
    ...(rewrittenTimeFilter
      ? { timeFilter: timeFilterToDateRange(rewrittenTimeFilter) }
      : {}),
  };
}

export const searchCompound = os
  .input(CompoundSearchSchema)
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Request cancellation, validated snapshots and deadline reporting share this handler.
  .handler(async ({ input }): Promise<SearchResponse> => {
    const started = performance.now();
    const cold =
      Boolean(input.query?.trim()) &&
      (!isAiSearchReady() ||
        (CHINESE_CHAR_RE.test(input.query ?? "") &&
          getTranslationState() !== "ready"));
    const diagnostics = createSearchDiagnostics(input.requestId, cold);
    const request = beginSearchRequest(
      ipcContext.mainWindow?.webContents.id ?? 0,
      diagnostics.requestId
    );
    const execution: CompoundSearchExecution = {
      signal: request.signal,
      deadline:
        started + (cold ? AI_SEARCH_COLD_TIMEOUT_MS : AI_SEARCH_TIMEOUT_MS),
      diagnostics,
    };
    const db = getDatabase();
    const includeVectors = needsVectorRevision(input);
    const sourceRevision = getSearchDatabaseRevision(db, includeVectors);
    diagnostics.timings.preparationMs = performance.now() - started;
    try {
      const response = (await performCompoundSearch(
        input,
        execution,
        sourceRevision
      )) as SearchResponse;
      if (request.signal.aborted) {
        return {
          results: [],
          total: 0,
          totalExact: false,
          completion: "cancelled",
          incompleteReason: "cancelled",
          diagnostics,
        };
      }
      if (
        !execution.snapshotValidated &&
        getSearchDatabaseRevision(db, includeVectors) !== sourceRevision
      ) {
        return {
          results: [],
          total: 0,
          totalExact: false,
          cursorExpired: Boolean(input.cursor),
          completion: "partial",
          incompleteReason: "changed",
          diagnostics,
        };
      }
      const deadlineExceeded =
        response.incompleteReason !== "changed" &&
        performance.now() >= execution.deadline;
      return {
        ...response,
        semanticRequired:
          response.semanticRequired ??
          (includeVectors &&
            !input.colorHex &&
            !HEX_COLOR_QUERY_RE.test(input.query?.trim() ?? "")),
        ...(deadlineExceeded
          ? { incompleteReason: "deadline" as const, totalExact: false }
          : {}),
        completion: deadlineExceeded
          ? "partial"
          : (response.completion ?? "complete"),
        diagnostics,
      };
    } catch (error) {
      if (!(error instanceof SearchInterrupted)) {
        throw error;
      }
      return {
        results: [],
        total: 0,
        totalExact: false,
        completion: error.reason === "cancelled" ? "cancelled" : "partial",
        incompleteReason: error.reason,
        diagnostics,
      };
    } finally {
      execution.finished = true;
      diagnostics.timings.serviceMs = performance.now() - started;
      request.finish();
    }
  });

export const cancelSearch = os
  .use(ipcContext.mainWindowContext)
  .input(z.object({ requestId: z.string().uuid() }))
  .handler(({ input, context }) => ({
    cancelled: cancelSearchRequest(
      context.window.webContents.id,
      input.requestId
    ),
  }));

// ── Spotlight 轻量搜索 ───────────────────────────────────────────────
// 专为 Ctrl+K 全局搜索设计：仅返回 id + filename + thumbnailPath，
// 跳过 LanceDB SigLIP 推理和四路并行重排，延迟极低（通常 < 30ms）。
export const searchSpotlight = os
  .input(SearchSchema)
  .handler(async ({ input }) => {
    const db = getDatabase();
    const q = input.query.trim();
    const limit = Math.min(input.limit ?? 8, 12);

    // 两路快速召回：FTS5 文件名 + 标签 LIKE（跳过 AI 和人脸）
    const settled = await Promise.allSettled([
      // 路 1：FTS5 文件名 MATCH（优先）→ LIKE 回退
      (() => {
        const needsFts5Escape = FTS5_QUOTE_RE.test(q);
        if (!needsFts5Escape && q.length > 0) {
          try {
            const normalized = q.replace(WHITESPACE_RE, " ");
            const terms = normalized
              .split(WHITESPACE_SPLIT_RE)
              .map((t) => `"${t}"*`)
              .join(" ");
            const ftsResults = db.all(
              sql`SELECT rowid AS id FROM photos_fts WHERE photos_fts MATCH ${terms}`
            ) as Array<{ id: number }>;
            if (ftsResults.length > 0) {
              return ftsResults.slice(0, limit);
            }
          } catch {
            /* FTS5 error → fallback */
          }
        }
        return db
          .select({ id: photos.id })
          .from(photos)
          .where(and(isNull(photos.deletedAt), like(photos.filename, `%${q}%`)))
          .limit(limit)
          .all();
      })(),
      // 路 2：标签 LIKE 搜索
      db
        .select({ id: photos.id })
        .from(photos)
        .innerJoin(photoTags, eq(photoTags.photoId, photos.id))
        .innerJoin(tags, eq(tags.id, photoTags.tagId))
        .where(
          and(
            isNull(photos.deletedAt),
            like(tags.name, `%${q}%`),
            or(
              eq(photoTags.origin, "manual"),
              eq(photoTags.userConfirmed, true)
            )
          )
        )
        .limit(limit)
        .all(),
    ]);

    // 合并去重（标签优先作为精确匹配）
    const merged = new Map<number, number>();
    const tagRows = settled[1].status === "fulfilled" ? settled[1].value : [];
    const ftsRows = settled[0].status === "fulfilled" ? settled[0].value : [];

    for (const r of tagRows) {
      merged.set(r.id, 1);
    }
    for (const r of ftsRows) {
      if (!merged.has(r.id)) {
        merged.set(r.id, 0);
      }
    }

    const ids = [...merged.keys()].slice(0, limit);
    if (ids.length === 0) {
      return { results: [], query: q };
    }

    // 仅返回三字段，IPC payload 极小
    const results = db
      .select({
        id: photos.id,
        filename: photos.filename,
        thumbnailPath: photos.thumbnailPath,
        path: photos.path,
      })
      .from(photos)
      .where(inArray(photos.id, ids))
      .all();

    return { results, query: q };
  });
