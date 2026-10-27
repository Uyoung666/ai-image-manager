import type { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { imageSearchActions } from "@/actions/image-search";
import { photoSequenceActions } from "@/actions/photo-sequences";
import type { useBrowseSession } from "@/contexts/BrowseSessionContext";
import type { useSidebarFilter } from "@/contexts/SidebarFilterContext";
import { usePhotoSearch } from "@/hooks/use-photo-search";
import type { Photo, SearchResponse } from "@/types/photo";
import type { PhotoSequence } from "@/types/photo-sequence";
import type { ExifFilters, SearchMode } from "@/types/search";
import { createSearchResultSourceKey } from "@/utils/gallery-view-state";
import {
  EMPTY_SEARCH_RESULT_METADATA,
  getSearchResultMetadata,
} from "@/utils/search-state";
import { buildHomeSearchParams } from "./build-home-search-params";
import type { PreparedSearchSequences } from "./use-home-sequence-query";

type SearchHandler = (
  query: string,
  filters?: ExifFilters,
  paramColorHex?: string,
  preserveDashboardReturn?: boolean
) => Promise<void>;
async function reloadSearchPrefix(
  params: { query: string; filters?: ExifFilters; colorHex?: string },
  targetCount: number,
  runSearch: ReturnType<typeof usePhotoSearch>["runSearch"],
  isCurrent: () => boolean
) {
  const results: Photo[] = [];
  const seen = new Set<number>();
  let cursor: string | undefined;
  let offset = 0;
  let page: SearchResponse;
  do {
    page = (await runSearch(
      buildHomeSearchParams(
        params.query,
        params.filters,
        params.colorHex,
        cursor ? { cursor } : { offset }
      )
    )) as SearchResponse;
    if (!isCurrent()) {
      return null;
    }
    const previousCount = results.length;
    for (const photo of page.results ?? []) {
      if (!seen.has(photo.id)) {
        seen.add(photo.id);
        results.push(photo);
      }
    }
    validateRefreshedPage(page, results.length - previousCount);
    cursor = page.nextCursor ?? undefined;
    offset = page.nextOffset ?? offset + (page.results?.length ?? 0);
  } while (page.hasMore && results.length < targetCount);
  return { results, page, cursor, offset };
}

function validateRefreshedPage(page: SearchResponse, added: number) {
  if (page.cursorExpired || page.incompleteReason === "changed") {
    throw new Error("Tag refresh snapshot changed");
  }
  // Frozen search sessions intentionally advance behind one stable cursor.
  if (page.hasMore && added === 0) {
    throw new Error("Tag refresh made no progress");
  }
}

export function resolveSearchMode(
  query: string,
  color?: string | null
): SearchMode {
  if (color) {
    return "color";
  }
  if (query.trim()) {
    return "text";
  }
  return "exif";
}
interface HomeSearchOptions {
  clearDashboardReturnTarget: () => void;
  filter: Pick<
    ReturnType<typeof useSidebarFilter>,
    "appliedSearch" | "applySearch" | "clearSearch"
  >;
  navigate: ReturnType<typeof useNavigate>;
  saveBrowseSession: ReturnType<typeof useBrowseSession>["saveSession"];
  setDrillDownFilters: React.Dispatch<
    React.SetStateAction<ExifFilters | undefined>
  >;
  setShowDrillBanner: React.Dispatch<React.SetStateAction<boolean>>;
}
/** Search results, continuation and cancellation share one request generation. */
export function useHomeSearch({
  filter,
  saveBrowseSession,
  navigate,
  clearDashboardReturnTarget,
  setDrillDownFilters,
  setShowDrillBanner,
}: HomeSearchOptions) {
  const { t } = useTranslation();
  const colorHex = filter.appliedSearch?.colorHex ?? null;

  const [searchTime, setSearchTime] = useState<number | undefined>(undefined);

  const [searchResults, setSearchResults] = useState<Photo[] | null>(null);

  const [searchMetadata, setSearchMetadata] = useState(
    EMPTY_SEARCH_RESULT_METADATA
  );

  const {
    exactTotal: searchExactTotal,
    incomplete: searchIncomplete,
    semantic: searchSemantic,
    semanticRequired: searchSemanticRequired,
    timeFilter: parsedTimeFilter,
  } = searchMetadata;

  const [searchError, setSearchError] = useState<"image" | "search" | null>(
    null
  );

  const [searchResultSourceKey, setSearchResultSourceKey] = useState<
    string | null
  >(null);

  const [searchResultGeneration, setSearchResultGeneration] = useState(0);
  const [preparedSearchSequences, setPreparedSearchSequences] =
    useState<PreparedSearchSequences | null>(null);
  const [searchRefreshing, setSearchRefreshing] = useState(false);
  const tagRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshAfterTagsRef = useRef<() => void>(() => undefined);
  const searchResultsRef = useRef(searchResults);
  searchResultsRef.current = searchResults;
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (tagRefreshTimerRef.current !== null) {
        clearTimeout(tagRefreshTimerRef.current);
      }
    };
  }, []);

  const pendingSemanticRefreshRef = useRef<{
    colorHex?: string;
    filters?: ExifFilters;
    generation: number;
    query: string;
  } | null>(null);

  const [searchHasMore, setSearchHasMore] = useState(false);

  const [paintMeasurement, setPaintMeasurement] = useState<{
    completion: SearchResponse["completion"];
    diagnostics: NonNullable<SearchResponse["diagnostics"]>;
    incompleteReason: SearchResponse["incompleteReason"];
    query: string;
    started: number;
  } | null>(null);

  useEffect(() => {
    if (!paintMeasurement) {
      return;
    }
    let nextFrame = 0;
    const frame = requestAnimationFrame(() => {
      nextFrame = requestAnimationFrame(() => {
        paintMeasurement.diagnostics.timings.firstPaintMs =
          performance.now() - paintMeasurement.started;
        window.dispatchEvent(
          new CustomEvent("photo-search-diagnostics", {
            detail: {
              ...paintMeasurement.diagnostics,
              completion: paintMeasurement.completion,
              incompleteReason: paintMeasurement.incompleteReason,
              query: paintMeasurement.query,
            },
          })
        );
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(nextFrame);
    };
  }, [paintMeasurement]);

  const searchLoadingMoreRef = useRef(false);

  const searchNextCursorRef = useRef<string | null>(null);

  const searchNextOffsetRef = useRef(0);

  const [isFetchingSearchNextPage, setIsFetchingSearchNextPage] =
    useState(false);

  const lastSearchParamsRef = useRef<{
    query: string;
    filters?: ExifFilters;
    colorHex?: string;
  } | null>(null);

  const lastImageSearchPathRef = useRef<string | null>(null);

  const [searchLoading, setSearchLoading] = useState(false);
  const searchLoadingRef = useRef(searchLoading);
  searchLoadingRef.current = searchLoading;

  const [imageSearchPreviewDataUrl, setImageSearchPreviewDataUrl] = useState<
    string | null
  >(null);

  const searchGenerationRef = useRef(0);

  const { runSearch: searchPhotos, cancelPending: cancelPendingPhotoSearch } =
    usePhotoSearch();

  const cancelTagRefresh = useCallback(() => {
    if (tagRefreshTimerRef.current !== null) {
      clearTimeout(tagRefreshTimerRef.current);
      tagRefreshTimerRef.current = null;
    }
    setSearchRefreshing(false);
    setPreparedSearchSequences(null);
  }, []);

  const resetHomeSearchState = useCallback(() => {
    cancelTagRefresh();
    cancelPendingPhotoSearch();
    searchGenerationRef.current += 1;
    pendingSemanticRefreshRef.current = null;
    searchLoadingMoreRef.current = false;
    searchNextCursorRef.current = null;
    searchNextOffsetRef.current = 0;
    setIsFetchingSearchNextPage(false);
    setSearchHasMore(false);
    lastSearchParamsRef.current = null;
    lastImageSearchPathRef.current = null;
    setSearchTime(undefined);
    setSearchResults(null);
    setSearchError(null);
    setSearchResultSourceKey(null);
    setSearchResultGeneration(0);
    setSearchMetadata(EMPTY_SEARCH_RESULT_METADATA);
    setPaintMeasurement(null);
    setSearchLoading(false);
    setImageSearchPreviewDataUrl(null);
    setShowDrillBanner(false);
    setDrillDownFilters(undefined);
    clearDashboardReturnTarget();
    saveBrowseSession("home-search", {
      colorHex: null,
      filters: {},
      imageSearchPath: null,
      searchMode: null,
      searchQuery: "",
    });
    navigate({ to: "/", search: {}, replace: true });
  }, [
    cancelTagRefresh,
    cancelPendingPhotoSearch,
    clearDashboardReturnTarget,
    navigate,
    saveBrowseSession,
    setDrillDownFilters,
    setShowDrillBanner,
  ]);

  const searchHandlerRef = useRef<SearchHandler | null>(null);

  const handleSearch = useCallback<SearchHandler>(
    (...args) => searchHandlerRef.current?.(...args) ?? Promise.resolve(),
    []
  );

  const handleSearchRetry = useCallback(() => {
    const params = lastSearchParamsRef.current;
    if (!params) {
      return;
    }
    handleSearch(params.query, params.filters, params.colorHex, true).catch(
      () => undefined
    );
  }, [handleSearch]);

  const refreshSearchAfterTags = useCallback(() => {
    const params = lastSearchParamsRef.current;
    if (!params?.query.trim()) {
      return;
    }
    if (searchResultsRef.current === null || searchLoadingRef.current) {
      handleSearchRetry();
      return;
    }
    cancelPendingPhotoSearch();
    const generation = ++searchGenerationRef.current;
    if (tagRefreshTimerRef.current !== null) {
      clearTimeout(tagRefreshTimerRef.current);
    }
    const targetCount = searchResultsRef.current.length;
    searchLoadingMoreRef.current = true;
    searchNextCursorRef.current = null;
    pendingSemanticRefreshRef.current = null;
    setSearchHasMore(false);
    setIsFetchingSearchNextPage(false);
    setSearchLoading(false);
    setSearchRefreshing(true);
    const isCurrent = () =>
      mountedRef.current && generation === searchGenerationRef.current;
    // Rebuild only the loaded prefix, keeping both the old view and its identity
    // until the new photos and sequence ownership can be committed together.
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: bounded refresh, ownership and retry share one generation guard.
    tagRefreshTimerRef.current = setTimeout(async () => {
      tagRefreshTimerRef.current = null;
      try {
        const refreshed = await reloadSearchPrefix(
          params,
          targetCount,
          searchPhotos,
          isCurrent
        );
        if (!refreshed) {
          return;
        }
        const { results, page, cursor, offset } = refreshed;
        const photoIds = results.map((photo) => photo.id);
        const sequences = photoIds.length
          ? ((await photoSequenceActions.list({
              scope: "members",
              photoIds,
            })) as PhotoSequence[])
          : [];
        if (!isCurrent()) {
          return;
        }
        setPreparedSearchSequences({ generation, photoIds, sequences });
        setSearchResults(results);
        setSearchResultGeneration(generation);
        setSearchMetadata(getSearchResultMetadata(page, params.query));
        setSearchError(null);
        searchNextCursorRef.current = cursor ?? null;
        searchNextOffsetRef.current = offset;
        setSearchHasMore(Boolean(page.hasMore));
        const semantic = page.semantic;
        if (
          semantic &&
          semantic.required !== false &&
          (semantic.state === "partial" || semantic.state === "unavailable")
        ) {
          pendingSemanticRefreshRef.current = { ...params, generation };
        }
      } catch {
        if (isCurrent()) {
          toast.error(t("loadFailedRetry"), {
            action: {
              label: t("retry"),
              onClick: () => {
                if (lastSearchParamsRef.current === params) {
                  refreshAfterTagsRef.current();
                }
              },
            },
          });
        }
      } finally {
        if (isCurrent()) {
          searchLoadingMoreRef.current = false;
          setSearchRefreshing(false);
        }
      }
    }, 150);
  }, [cancelPendingPhotoSearch, handleSearchRetry, searchPhotos, t]);
  refreshAfterTagsRef.current = refreshSearchAfterTags;

  const handleImageSearchRetry = useCallback(() => {
    const imagePath = lastImageSearchPathRef.current;
    if (imagePath) {
      imageSearchRef.current(imagePath).catch(() => undefined);
    }
  }, []);

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: search fallback and semantic refresh share one request lifecycle
  async function performSearch(
    query: string,
    filters?: ExifFilters,
    paramColorHex?: string,
    preserveDashboardReturn = false
  ) {
    cancelTagRefresh();
    if (!preserveDashboardReturn) {
      clearDashboardReturnTarget();
      setDrillDownFilters(undefined);
      setShowDrillBanner(false);
    }
    // paramColorHex 未传时沿用当前 state（保留钻取来的色彩筛选）
    const effectiveColorHex =
      paramColorHex === undefined ? colorHex : paramColorHex;
    const hasFilters = filters && Object.values(filters).some((v) => v);
    const hasColorHex = !!effectiveColorHex;

    if (!(query.trim() || hasFilters || hasColorHex)) {
      cancelPendingPhotoSearch();
      searchGenerationRef.current += 1;
      setPaintMeasurement(null);
      filter.clearSearch();
      pendingSemanticRefreshRef.current = null;
      setSearchError(null);
      setSearchMetadata(EMPTY_SEARCH_RESULT_METADATA);
      setSearchTime(undefined);
      setSearchResults(null);
      setSearchResultSourceKey(null);
      setSearchResultGeneration(0);
      setSearchHasMore(false);
      return;
    }

    // 递增代数，使前一个未完成的请求变成 stale
    cancelPendingPhotoSearch();
    const gen = ++searchGenerationRef.current;
    setPaintMeasurement(null);
    setSearchMetadata(EMPTY_SEARCH_RESULT_METADATA);
    setSearchTime(undefined);
    pendingSemanticRefreshRef.current = null;
    const startTime = performance.now();
    const nextSearchMode = resolveSearchMode(query, effectiveColorHex);
    const appliedFilters = filters ?? {};
    filter.applySearch({
      colorHex: effectiveColorHex ?? undefined,
      filters: appliedFilters,
      mode: nextSearchMode,
      query,
    });
    saveBrowseSession("home-search", {
      colorHex: effectiveColorHex ?? null,
      filters: appliedFilters,
      imageSearchPath: null,
      searchMode: nextSearchMode,
      searchQuery: query,
    });
    setSearchLoading(true);
    setSearchError(null);
    searchLoadingMoreRef.current = false;
    searchNextCursorRef.current = null;
    searchNextOffsetRef.current = 0;
    setIsFetchingSearchNextPage(false);
    setSearchHasMore(false);

    try {
      const searchParams = buildHomeSearchParams(
        query,
        filters,
        effectiveColorHex
      );

      // Preserve normalized parameters for relevance-bounded pagination.
      lastSearchParamsRef.current = {
        query,
        filters,
        colorHex: effectiveColorHex ?? undefined,
      };

      const result = (await searchPhotos(searchParams)) as SearchResponse;

      // 竞态保护：如果代数不匹配，说明已有更新的搜索启动，丢弃此过时响应
      if (gen !== searchGenerationRef.current) {
        return;
      }

      const results = result.results || [];
      setSearchMetadata(getSearchResultMetadata(result, query));
      if (result.diagnostics) {
        setPaintMeasurement({
          completion: result.completion,
          diagnostics: result.diagnostics,
          incompleteReason: result.incompleteReason,
          query,
          started: startTime,
        });
      }
      searchNextCursorRef.current = result.nextCursor ?? null;
      searchNextOffsetRef.current = result.nextOffset ?? results.length;
      setSearchHasMore(Boolean(result.hasMore));
      const semantic = result.semantic;
      if (
        semantic &&
        semantic.required !== false &&
        (semantic.state === "partial" || semantic.state === "unavailable") &&
        query.trim()
      ) {
        pendingSemanticRefreshRef.current = {
          generation: gen,
          query,
          filters,
          colorHex: effectiveColorHex ?? undefined,
        };
      } else {
        pendingSemanticRefreshRef.current = null;
      }

      setSearchResults(results);
      setSearchError(null);
      setSearchResultGeneration(gen);
      setSearchResultSourceKey(
        createSearchResultSourceKey(
          gen,
          results.map((photo) => photo.id)
        )
      );
      setSearchTime(Math.round(performance.now() - startTime));
    } catch {
      if (gen !== searchGenerationRef.current) {
        return;
      }
      setSearchHasMore(false);
      setSearchMetadata(EMPTY_SEARCH_RESULT_METADATA);
      setPaintMeasurement(null);
      pendingSemanticRefreshRef.current = null;
      setSearchResults([]);
      setSearchError("search");
      setSearchResultGeneration(gen);
      setSearchResultSourceKey(createSearchResultSourceKey(gen, []));
      setSearchTime(Math.round(performance.now() - startTime));
    } finally {
      if (gen === searchGenerationRef.current) {
        setSearchLoading(false);
      }
    }
  }

  searchHandlerRef.current = performSearch;

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: image search coordinates preview, source validation, and generation-safe result states
  async function handleImageSearch(imagePath: string) {
    cancelTagRefresh();
    cancelPendingPhotoSearch();
    const gen = ++searchGenerationRef.current;
    setSearchMetadata(EMPTY_SEARCH_RESULT_METADATA);
    pendingSemanticRefreshRef.current = null;
    setPaintMeasurement(null);
    setSearchTime(undefined);
    searchLoadingMoreRef.current = false;
    searchNextCursorRef.current = null;
    searchNextOffsetRef.current = 0;
    setIsFetchingSearchNextPage(false);
    lastSearchParamsRef.current = null;
    lastImageSearchPathRef.current = imagePath;
    filter.applySearch({
      filters: {},
      imagePath,
      mode: "image",
      query: "",
    });
    saveBrowseSession("home-search", {
      colorHex: null,
      filters: {},
      imageSearchPath: imagePath,
      searchMode: "image",
      searchQuery: "",
    });
    setImageSearchPreviewDataUrl(null);
    setSearchLoading(true);
    setSearchError(null);
    setSearchHasMore(false);
    const startTime = performance.now();
    try {
      const previewPromise = imageSearchActions
        .getPreview(imagePath)
        .then((preview) => {
          if (gen === searchGenerationRef.current && preview.exists) {
            setImageSearchPreviewDataUrl(preview.dataUrl);
          }
          return preview;
        })
        .catch(() => ({ dataUrl: null, exists: true }));
      const [result, preview] = await Promise.all([
        imageSearchActions.search(imagePath, 500),
        previewPromise,
      ]);
      // 竞态保护：丢弃过时响应
      if (gen !== searchGenerationRef.current) {
        return;
      }
      if (!preview.exists || result.errorCode === "SOURCE_NOT_FOUND") {
        filter.clearSearch();
        setImageSearchPreviewDataUrl(null);
        toast.error(t("toastImageSearchSourceMissing"));
        return;
      }
      if (result.errorCode === "AI_SEARCH_FAILED") {
        console.warn("[ImageSearch]", result.error);
        setSearchResults([]);
        setSearchError("image");
        setSearchResultGeneration(gen);
        setSearchResultSourceKey(createSearchResultSourceKey(gen, []));
        setSearchTime(Math.round(performance.now() - startTime));
        return;
      }
      if (result.error) {
        console.warn("[ImageSearch]", result.error);
      }
      const results = (result as { results?: Photo[] }).results ?? [];
      setSearchResults(results);
      setSearchError(null);
      setSearchResultGeneration(gen);
      setSearchResultSourceKey(
        createSearchResultSourceKey(
          gen,
          results.map((photo: Photo) => photo.id)
        )
      );
      setSearchTime(Math.round(performance.now() - startTime));
    } catch (err: unknown) {
      if (gen !== searchGenerationRef.current) {
        return;
      }
      console.error(
        "[ImageSearch] failed:",
        err instanceof Error ? err.message : err
      );
      toast.error(t("toastImageSearchFailed"));
      setSearchResults([]);
      setSearchError("image");
      setSearchResultGeneration(gen);
      setSearchResultSourceKey(createSearchResultSourceKey(gen, []));
      setSearchTime(Math.round(performance.now() - startTime));
    } finally {
      if (gen === searchGenerationRef.current) {
        setSearchLoading(false);
      }
    }
  }
  const imageSearchRef = useRef(handleImageSearch);
  imageSearchRef.current = handleImageSearch;
  const loadMoreSearchResults = useCallback(() => {
    // Search pages are relevance-bounded, not capped by the UI. Continue
    // until the backend reports that the semantic tail is exhausted.
    const p = lastSearchParamsRef.current;
    if (!p || searchLoadingMoreRef.current) {
      return;
    }
    searchLoadingMoreRef.current = true;
    setIsFetchingSearchNextPage(true);
    const generation = searchGenerationRef.current;

    const startTime = performance.now();
    const requestedCursor = searchNextCursorRef.current;
    const requestedOffset = searchNextOffsetRef.current;
    const searchParams = buildHomeSearchParams(
      p.query,
      p.filters,
      p.colorHex,
      requestedCursor
        ? { cursor: requestedCursor }
        : { offset: requestedOffset }
    );

    searchPhotos(searchParams)
      .then((rawResult) => {
        const result = rawResult as SearchResponse;
        if (
          generation !== searchGenerationRef.current ||
          (requestedCursor !== null &&
            requestedCursor !== searchNextCursorRef.current)
        ) {
          return;
        }
        if (result.cursorExpired) {
          setSearchMetadata((current) => ({
            ...current,
            exactTotal: null,
            incomplete: true,
          }));
          setSearchHasMore(false);
          searchNextCursorRef.current = null;
          toast.info(t("searchCursorExpired"));
          return;
        }
        setSearchMetadata(getSearchResultMetadata(result, p.query));
        const newResults = result.results || [];
        if (newResults.length > 0) {
          setSearchResults((current) => {
            const existing = new Set((current ?? []).map((photo) => photo.id));
            return [
              ...(current ?? []),
              ...newResults.filter((photo: Photo) => !existing.has(photo.id)),
            ];
          });
          setSearchTime(Math.round(performance.now() - startTime));
        }
        searchNextCursorRef.current = result.nextCursor ?? null;
        searchNextOffsetRef.current =
          result.nextOffset ?? requestedOffset + newResults.length;
        setSearchHasMore(Boolean(result.hasMore));
      })
      .catch(() => {
        if (generation === searchGenerationRef.current) {
          setSearchHasMore(false);
          setSearchMetadata((current) => ({
            ...current,
            exactTotal: null,
            incomplete: true,
          }));
        }
      })
      .finally(() => {
        if (generation !== searchGenerationRef.current) {
          return;
        }
        searchLoadingMoreRef.current = false;
        setIsFetchingSearchNextPage(false);
      });
  }, [searchPhotos, t]);
  return {
    searchTime,
    setSearchTime,
    searchResults,
    setSearchResults,
    searchExactTotal,
    searchIncomplete,
    searchSemantic,
    searchSemanticRequired,
    parsedTimeFilter,
    searchError,
    searchResultSourceKey,
    searchResultGeneration,
    preparedSearchSequences,
    searchRefreshing,
    refreshSearchAfterTags,
    pendingSemanticRefreshRef,
    searchHasMore,
    searchLoadingMoreRef,
    isFetchingSearchNextPage,
    lastSearchParamsRef,
    searchLoading,
    imageSearchPreviewDataUrl,
    searchGenerationRef,
    resetHomeSearchState,
    handleSearch,
    handleSearchRetry,
    handleImageSearchRetry,
    handleImageSearch,
    loadMoreSearchResults,
  };
}
