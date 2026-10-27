import { performance } from "node:perf_hooks";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import { exifData, photos, photoTags, photoViewStats, tags } from "@/db/schema";
import { getAiControlState } from "@/services/ai/state";
import { CANDIDATE_TAGS } from "@/services/ai/tag-suggester";
import { isAiSearchReady, searchByTextWithPlan } from "@/services/ai-embedder";
import { rewriteQuery } from "@/services/query-rewrite";
import { beginBackgroundSearch } from "@/services/search-background";
import { getSearchDatabaseRevision } from "@/services/search-revision";
import {
  buildPhotoSearchScope,
  getPhotoSearchScope,
} from "@/services/search-scope";
import type {
  SearchStarter,
  SearchStarterInput,
  SearchStarterResponse,
} from "@/types/search-starters";
import { buildSearchFilterParams } from "@/utils/search-filter-params";
import {
  buildStarterCandidates,
  type StarterCandidate,
  type StarterPhotoEvidence,
} from "./search-starter-candidates";
import { getSearchStarterContext } from "./search-starter-context";
import { starterTopics } from "./search-starter-rotation";

const MAX_CACHE_ENTRIES = 8;
const MAX_VALIDATIONS = 16;
const caches = new Map<string, SearchStarterResponse>();
const pending = new Map<string, Promise<SearchStarterResponse>>();
const ARTICLE_PATTERN = /^(?:a|an) /;
const QUERY_OPERATORS = /[*?["“”]/;
const CHINESE_CHAR = /[一-鿿]/;
const vocabulary = CANDIDATE_TAGS.map((tag) => ({
  zh: tag.zh,
  en: tag.siglipLabel.replace(ARTICLE_PATTERN, ""),
  category: tag.category,
}));

function validationOrder(candidates: StarterCandidate[]): StarterCandidate[] {
  const queues = ["library", "interest", "rediscovery"].map((source) =>
    candidates.filter((item) => item.source === source)
  );
  const interleaved = Array.from(
    { length: Math.max(...queues.map((queue) => queue.length)) },
    (_, index) =>
      queues.flatMap((queue) => (queue[index] ? [queue[index]] : []))
  ).flat();
  const remaining = [
    ...new Map(interleaved.map((item) => [item.key, item])).values(),
  ];
  const seen = new Map<string, number>();
  const ordered: StarterCandidate[] = [];
  const overlap = (candidate: StarterCandidate) =>
    starterTopics(candidate).reduce(
      (sum, topic) => sum + (seen.get(topic) ?? 0),
      0
    );
  while (remaining.length > 0) {
    remaining.sort((left, right) => overlap(left) - overlap(right));
    const candidate = remaining.shift();
    if (!candidate) {
      break;
    }
    ordered.push(candidate);
    for (const topic of starterTopics(candidate)) {
      seen.set(topic, (seen.get(topic) ?? 0) + 1);
    }
  }
  return ordered;
}

async function validateCandidate(
  candidate: StarterCandidate,
  input: SearchStarterInput,
  revision: string,
  signal: AbortSignal,
  deadline: number
): Promise<number[]> {
  const query = candidate.query ?? candidate.text;
  if (
    query.length > 200 ||
    query.startsWith("#") ||
    QUERY_OPERATORS.test(query)
  ) {
    return [];
  }
  const rewritten = CHINESE_CHAR.test(query) ? rewriteQuery(query) : undefined;
  // Date templates carry explicit filters; arbitrary tag names must not become time commands.
  if (rewritten?.timeFilter || rewritten?.cleanQuery === "") {
    return [];
  }
  const db = getDatabase();
  const scope = getPhotoSearchScope(
    db,
    { ...input.filters, ...buildSearchFilterParams(candidate.filters) },
    getSearchDatabaseRevision(db, false)
  );
  const result = await searchByTextWithPlan(rewritten?.cleanQuery ?? query, 8, {
    signal,
    deadline,
    allowedPhotoIds: scope.allowedPhotoIds,
    scopeKey: scope.key,
    sourceRevision: revision,
    rewritten,
  });
  // Uncalibrated models return unfiltered top-K; accepted evidence is mandatory.
  if (result.strongAccepted === 0 && result.supportedAccepted === 0) {
    return [];
  }
  return result.results
    .filter((match) => candidate.photoIds.includes(match.photoId))
    .slice(0, 3)
    .map((match) => match.photoId);
}

async function validateCandidates(
  candidates: StarterCandidate[],
  input: SearchStarterInput,
  response: SearchStarterResponse,
  signal: AbortSignal
): Promise<boolean> {
  const validated = new Map<string, number[]>();
  const deadline = performance.now() + 15_000;
  for (const candidate of validationOrder(candidates)) {
    if (
      signal.aborted ||
      performance.now() >= deadline ||
      getAiControlState() !== "idle"
    ) {
      return true;
    }
    if (!validated.has(candidate.key)) {
      if (validated.size >= MAX_VALIDATIONS) {
        continue;
      }
      validated.set(
        candidate.key,
        await validateCandidate(
          candidate,
          input,
          response.revision,
          signal,
          deadline
        )
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const previewPhotoIds = validated.get(candidate.key) ?? [];
    if (previewPhotoIds.length > 0) {
      for (const alias of candidates.filter(
        (item) => item.key === candidate.key
      )) {
        const { score: _score, photoIds: _photoIds, ...starter } = alias;
        response.candidates.push({
          ...starter,
          kind: "semantic",
          previewPhotoIds,
        });
      }
    }
  }
  return false;
}

function loadEvidence(
  db: ReturnType<typeof getDatabase>,
  input: SearchStarterInput
) {
  const scope = buildPhotoSearchScope(db, input.filters);
  const columns = {
    id: photos.id,
    dateTaken: exifData.dateTaken,
    favorite: photos.isFavorite,
    views: sql<number>`COALESCE(${photoViewStats.viewCount}, 0)`,
    lastViewedAt: photoViewStats.lastViewedAt,
  };
  const query = () =>
    db
      .select(columns)
      .from(photos)
      .leftJoin(exifData, eq(exifData.photoId, photos.id))
      .leftJoin(photoViewStats, eq(photoViewStats.photoId, photos.id));
  // Include recent, old and preferred photos without loading an entire library.
  const sample = [
    ...query()
      .where(scope)
      .orderBy(desc(photos.createdAt), desc(photos.id))
      .limit(1024)
      .all(),
    ...query()
      .where(and(scope, sql`${exifData.dateTaken} IS NOT NULL`))
      .orderBy(asc(exifData.dateTaken))
      .limit(512)
      .all(),
    ...query()
      .where(
        and(
          scope,
          or(eq(photos.isFavorite, true), sql`${photoViewStats.viewCount} > 0`)
        )
      )
      .orderBy(desc(photos.isFavorite), desc(photoViewStats.lastViewedAt))
      .limit(512)
      .all(),
  ];
  const sampled = [
    ...new Map(sample.map((photo) => [photo.id, photo])).values(),
  ] as StarterPhotoEvidence[];
  if (sampled.length === 0) {
    return { sampled, evidence: [] };
  }
  const evidence = db
    .select({
      photoId: photoTags.photoId,
      name: tags.name,
      manual: sql<boolean>`${photoTags.origin} = 'manual' OR ${photoTags.userConfirmed} = 1`,
    })
    .from(photoTags)
    .innerJoin(tags, eq(tags.id, photoTags.tagId))
    .where(
      and(
        inArray(
          photoTags.photoId,
          sampled.map((photo) => photo.id)
        ),
        sql`(${photoTags.origin} = 'manual' OR ${photoTags.userConfirmed} = 1 OR COALESCE(${photoTags.confidence}, 0) >= 0.55)`,
        sql`NOT EXISTS (SELECT 1 FROM tags child WHERE child.parent_id = ${tags.id})`
      )
    )
    .all()
    .filter(
      (row): row is typeof row & { photoId: number } => row.photoId !== null
    );
  return { sampled, evidence };
}

async function prepareStarters(
  input: SearchStarterInput,
  revision: string,
  day: string,
  validity: string
): Promise<SearchStarterResponse> {
  const response: SearchStarterResponse = {
    candidates: [],
    revision,
    validity,
    day,
    status: "empty",
  };
  const background = beginBackgroundSearch();
  try {
    if (background.signal.aborted) {
      return { ...response, status: "busy" };
    }
    // Yield before SQL and between individual worker requests.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (background.signal.aborted) {
      return { ...response, status: "busy" };
    }
    const db = getDatabase();
    const { sampled, evidence } = loadEvidence(db, input);
    const candidates = buildStarterCandidates(
      input,
      sampled,
      evidence,
      vocabulary
    );
    const interrupted = await validateCandidates(
      candidates,
      input,
      response,
      background.signal
    );
    const current = getSearchStarterContext(db);
    if (current.validity !== validity) {
      return { ...response, ...current, candidates: [], status: "busy" };
    }
    if (response.candidates.length > 0) {
      response.status = "ready";
    } else if (interrupted) {
      response.status = "busy";
    }
    return response;
  } catch (error) {
    if (background.signal.aborted) {
      return {
        ...response,
        status: response.candidates.length ? "ready" : "busy",
      };
    }
    console.warn(
      "[SearchStarters] Preparation failed:",
      error instanceof Error ? error.message : String(error)
    );
    return {
      ...response,
      status: response.candidates.length ? "ready" : "error",
    };
  } finally {
    background.finish();
  }
}

export function getSearchStarters(
  input: SearchStarterInput
): Promise<SearchStarterResponse> {
  const db = getDatabase();
  const { revision, validity, day } = getSearchStarterContext(db);
  const base = { candidates: [] as SearchStarter[], revision, validity, day };
  if (input.colorHex) {
    return Promise.resolve({ ...base, status: "color" });
  }
  if (!isAiSearchReady()) {
    return Promise.resolve({ ...base, status: "unavailable" });
  }
  if (getAiControlState() !== "idle") {
    return Promise.resolve({ ...base, status: "busy" });
  }
  const key = JSON.stringify([
    revision,
    day,
    input.language,
    input.history,
    Object.entries(input.filters).sort(([a], [b]) => a.localeCompare(b)),
  ]);
  const cached = caches.get(key);
  if (cached) {
    return Promise.resolve(cached);
  }
  const existing = pending.get(key);
  if (existing) {
    return existing;
  }
  // One background producer at a time, including requests from multiple windows.
  if (pending.size > 0) {
    return Promise.resolve({ ...base, status: "busy" });
  }
  const task = prepareStarters(input, revision, day, validity)
    .then((response) => {
      if (response.status === "ready" || response.status === "empty") {
        if (caches.size >= MAX_CACHE_ENTRIES) {
          const oldest = caches.keys().next().value;
          if (oldest !== undefined) {
            caches.delete(oldest);
          }
        }
        caches.set(key, response);
      }
      return response;
    })
    .finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}
