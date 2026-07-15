import type { BKTree } from "@/services/bk-tree";
import type { PendingRow } from "./queries";

interface ComparedPairCache {
  latestKey: string | null;
  maxLogId: number;
  set: Set<string>;
}

interface BkTreeCache {
  idsHash: string;
  photoMap: Map<number, PendingRow>;
  tree: BKTree;
}

export interface SimPair {
  aId: number;
  bId: number;
  distance: number;
}

interface SimilarityCache {
  idsHash: string;
  pairs: SimPair[];
}

interface CurateOrderCache {
  orderedIds: number[];
}

export const comparedPairCaches = new Map<number, ComparedPairCache>();
export const bkTreeCaches = new Map<number, BkTreeCache>();
export const similarityCaches = new Map<number, SimilarityCache>();
export const curateOrderCaches = new Map<number, CurateOrderCache>();

export function setBoundedCullCache<T>(
  cache: Map<number, T>,
  sessionId: number,
  value: T,
  maxSessions = 20
) {
  cache.delete(sessionId);
  cache.set(sessionId, value);
  while (cache.size > maxSessions) {
    const oldestSessionId = cache.keys().next().value;
    if (oldestSessionId === undefined) {
      break;
    }
    cache.delete(oldestSessionId);
  }
}

export function clearCullCaches(sessionId: number) {
  comparedPairCaches.delete(sessionId);
  bkTreeCaches.delete(sessionId);
  similarityCaches.delete(sessionId);
  curateOrderCaches.delete(sessionId);
}

export function clearCullPairCaches(sessionId: number) {
  comparedPairCaches.delete(sessionId);
  bkTreeCaches.delete(sessionId);
  similarityCaches.delete(sessionId);
}
