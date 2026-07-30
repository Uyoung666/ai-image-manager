import { randomUUID } from "node:crypto";

export interface SearchSession {
  candidateDepth: number;
  cursor: string;
  emittedIds: Set<number>;
  fingerprint: string;
  lastAccess: number;
  rankedPool: SearchSessionResult[];
  responseBase?: Record<string, unknown>;
  snapshotVersion: string;
  tagEvidence?: unknown;
  upstreamHasMore: boolean;
}

export type SearchSessionResult = { id: number } & Record<string, unknown>;

interface SearchSessionStoreOptions {
  createCursor?: () => string;
  maxSessions?: number;
  now?: () => number;
  ttlMs?: number;
}

export function createSearchFingerprint(
  input: Record<string, unknown>
): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(input)
        .filter(
          ([key, value]) =>
            !["cursor", "limit", "offset"].includes(key) && value !== undefined
        )
        .sort(([left], [right]) => left.localeCompare(right))
    )
  );
}

export function takeUnemittedSearchResults<T extends { id: number }>(
  session: SearchSession,
  results: T[],
  limit: number
): T[] {
  return results
    .filter((result) => !session.emittedIds.has(result.id))
    .slice(0, limit);
}

export function appendToFrozenSearchPool<T extends SearchSessionResult>(
  session: SearchSession,
  results: T[]
): void {
  const knownIds = new Set([
    ...session.emittedIds,
    ...session.rankedPool.map((result) => result.id),
  ]);
  for (const result of results) {
    if (!knownIds.has(result.id)) {
      session.rankedPool.push(result);
      knownIds.add(result.id);
    }
  }
}

export function takeFrozenSearchPage<T extends SearchSessionResult>(
  session: SearchSession,
  limit: number
): T[] {
  return session.rankedPool.splice(0, limit) as T[];
}

export class SearchSessionStore {
  private readonly createCursor: () => string;
  private readonly maxSessions: number;
  private readonly now: () => number;
  private readonly sessions = new Map<string, SearchSession>();
  private readonly ttlMs: number;

  constructor(options: SearchSessionStoreOptions = {}) {
    this.createCursor = options.createCursor ?? randomUUID;
    this.maxSessions = options.maxSessions ?? 20;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 30 * 60 * 1000;
  }

  create(fingerprint: string, candidateDepth: number): SearchSession {
    this.prune();
    while (this.sessions.size >= this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.sessions.delete(oldest);
    }
    const cursor = this.createCursor();
    const now = this.now();
    const session: SearchSession = {
      candidateDepth,
      cursor,
      emittedIds: new Set(),
      fingerprint,
      lastAccess: now,
      rankedPool: [],
      snapshotVersion: `hybrid-v3:${now}:${cursor}`,
      upstreamHasMore: false,
    };
    this.sessions.set(cursor, session);
    return session;
  }

  get(cursor: string): SearchSession | null {
    this.prune();
    const session = this.sessions.get(cursor);
    if (!session) {
      return null;
    }
    session.lastAccess = this.now();
    this.sessions.delete(cursor);
    this.sessions.set(cursor, session);
    return session;
  }

  private prune(): void {
    const now = this.now();
    for (const [cursor, session] of this.sessions) {
      if (now - session.lastAccess > this.ttlMs) {
        this.sessions.delete(cursor);
      }
    }
  }
}
