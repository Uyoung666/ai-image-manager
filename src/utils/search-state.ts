import type { SearchResponse } from "@/types/photo";

export interface SearchResultMetadata {
  exactTotal: number | null;
  incomplete: boolean;
  semantic: SearchResponse["semantic"] | null;
  semanticRequired: boolean;
  timeFilter: {
    dateFrom: string;
    dateTo: string;
    keyword: string;
  } | null;
}

export const EMPTY_SEARCH_RESULT_METADATA: SearchResultMetadata = {
  exactTotal: null,
  incomplete: false,
  semantic: null,
  semanticRequired: false,
  timeFilter: null,
};

const TIME_KEYWORDS = [
  "今天",
  "昨天",
  "前天",
  "上周",
  "上个月",
  "本月",
  "这个月",
  "今年",
  "去年",
  "本周",
  "这个星期",
  "上星期",
];

/** Each accepted page replaces metadata from the same search generation. */
export function getSearchResultMetadata(
  response: SearchResponse,
  query: string
): SearchResultMetadata {
  return {
    exactTotal: response.totalExact ? response.total : null,
    incomplete:
      response.completion === "partial" || response.completion === "cancelled",
    semantic: response.semantic ?? null,
    semanticRequired:
      response.semantic?.required ??
      response.semanticRequired ??
      !(response.timeFilter && !response.semantic),
    timeFilter: response.timeFilter
      ? {
          ...response.timeFilter,
          keyword:
            TIME_KEYWORDS.find((keyword) => query.includes(keyword)) ?? "",
        }
      : null,
  };
}

export interface SavedSearchRestoreState {
  drillConsumed: boolean;
  hasDrillParams: boolean;
  restored: boolean;
}

/** Saved search restoration must not run after a drill-down was handled. */
export function shouldRestoreSavedSearch({
  drillConsumed,
  hasDrillParams,
  restored,
}: SavedSearchRestoreState): boolean {
  return !(drillConsumed || hasDrillParams || restored);
}
