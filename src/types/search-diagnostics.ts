export type SearchCompletion = "complete" | "partial" | "cancelled";

export type SearchIncompleteReason =
  | "deadline"
  | "cancelled"
  | "changed"
  | "semantic-unavailable";

export type SearchPhase =
  | "preparationMs"
  | "queueMs"
  | "translationMs"
  | "textEncodingMs"
  | "vectorMs"
  | "sqliteMs"
  | "rankingMs"
  | "hydrationMs"
  | "serviceMs"
  | "ipcMs"
  | "firstPaintMs";

export interface SearchDiagnostics {
  cacheHit: boolean;
  cold: boolean;
  requestId: string;
  timings: Record<SearchPhase, number | null>;
}
