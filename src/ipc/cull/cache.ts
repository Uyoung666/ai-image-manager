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

export const comparedPairCaches = new Map<number, ComparedPairCache>();
export const bkTreeCaches = new Map<number, BkTreeCache>();
export const similarityCaches = new Map<number, SimilarityCache>();

export function clearCullCaches(sessionId: number) {
  comparedPairCaches.delete(sessionId);
  bkTreeCaches.delete(sessionId);
  similarityCaches.delete(sessionId);
}
