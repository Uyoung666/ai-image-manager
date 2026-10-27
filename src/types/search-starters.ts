import type { PhotoSearchFilters } from "@/services/search-scope";
import type { ExifFilters } from "@/types/search";

export type SearchStarterSource = "library" | "interest" | "rediscovery";

export interface SearchStarter {
  filters?: Pick<ExifFilters, "dateFrom" | "dateTo">;
  key: string;
  kind?: "semantic" | "month" | "tag";
  /** Accepted result IDs only, ordered as cover and at most two fallbacks. */
  previewPhotoIds?: number[];
  query?: string;
  source: SearchStarterSource;
  text: string;
  /** Stable semantic identities, shared by single and combined phrases. */
  topics: string[];
}

export interface SearchStarterInput {
  colorHex?: string;
  filters: PhotoSearchFilters;
  history: string[];
  language: "zh" | "en";
  /** Metadata display locale, independent of the semantic query language. */
  locale?: "zh" | "en" | "ja";
}

export interface SearchStarterResponse {
  candidates: SearchStarter[];
  day: string;
  emptyReason?: "library" | "scope" | "no-candidates";
  revision: string;
  status: "ready" | "empty" | "unavailable" | "color" | "busy" | "error";
  /** Search eligibility, independent of history and preference ranking changes. */
  validity?: string;
}
