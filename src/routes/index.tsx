import type { InfiniteData } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { CircleAlert, Images, Layers } from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EmptyStateCard } from "@/components/EmptyStateCard";
import type { MasonryGridHandle } from "@/components/MasonryGrid";
import { clearImageLoadCache } from "@/components/PhotoCard";
import type { MenuState } from "@/components/PhotoContextMenu";
import { PhotoContextMenu } from "@/components/PhotoContextMenu";
import { loadPhotoDetailPanelWidth } from "@/components/PhotoDetailPanel";
import {
  GRID_COLUMN_WIDTH_KEY,
  loadGridColumnWidth,
  PhotoGrid,
  type SortField,
  type SortOrder,
} from "@/components/PhotoGrid";
import { PhotoLightbox } from "@/components/PhotoLightbox";
import { QuickPreview } from "@/components/QuickPreview";
import { SearchEmptyState } from "@/components/SearchEmptyState";
import { SelectionActionBar } from "@/components/SelectionActionBar";
import { SequenceSuggestionsDialog } from "@/components/SequenceSuggestionsDialog";
import { StatusBar } from "@/components/StatusBar";
import { Welcome } from "@/components/Welcome";
import { useBrowseSession } from "@/contexts/BrowseSessionContext";
import { useImportDropContext } from "@/contexts/import-drop-context";
import { useScrollPosition } from "@/contexts/ScrollPositionContext";
import { useSidebarFilter } from "@/contexts/SidebarFilterContext";
import { HomeActionDialogs } from "@/features/home/HomeActionDialogs";
import { HomeDetailPanel } from "@/features/home/HomeDetailPanel";
import { HomeToolbar } from "@/features/home/HomeToolbar";
import { useHomeBatchFavorite } from "@/features/home/use-home-batch-favorite";
import { useHomePhotoActions } from "@/features/home/use-home-photo-actions";
import {
  resolveSearchMode,
  useHomeSearch,
} from "@/features/home/use-home-search";
import { useHomeSelection } from "@/features/home/use-home-selection";
import { useHomeSequenceActions } from "@/features/home/use-home-sequence-actions";
import { useHomeSequenceDetails } from "@/features/home/use-home-sequence-details";
import { useHomeSequenceQuery } from "@/features/home/use-home-sequence-query";
import { useGlobalAiStatus } from "@/hooks/use-global-ai-status";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useModalFocusTrap } from "@/hooks/use-modal-focus-trap";
import { useAiStatus } from "@/hooks/useAiStatus";
import { useFolders } from "@/hooks/useFolders";
import { useGalleryReturn } from "@/hooks/useGalleryReturn";
import { useGallerySnapshot } from "@/hooks/useGallerySnapshot";
import { usePhotoDetailPanel } from "@/hooks/usePhotoDetailPanel";
import { usePhotos } from "@/hooks/usePhotos";
import { useScrollRestorePreloader } from "@/hooks/useScrollRestorePreloader";
import { useSequenceSuggestions } from "@/hooks/useSequenceSuggestions";
import { ipc } from "@/ipc/manager";
import { queryClient } from "@/providers/QueryProvider";
import type { Photo, PhotoListResponse } from "@/types/photo";
import type { PhotoSequenceDetail } from "@/types/photo-sequence";
import type { ExifFilters, SearchMode } from "@/types/search";
import {
  type DashboardReturnTarget,
  parseDashboardReturnTarget,
} from "@/utils/dashboard-data";
import { recordGalleryPerf } from "@/utils/gallery-perf";
import {
  canPaginateGalleryPhotos,
  getDisplayedSequenceMode,
  getSequenceResolvedPhotos,
  isGalleryRevealPending,
  shouldUseImmediateGalleryPhotos,
} from "@/utils/gallery-view-state";
import {
  cancelGalleryViewTransition,
  startGalleryViewTransition,
} from "@/utils/gallery-view-transition";
import { shouldRestoreSavedSearch } from "@/utils/search-state";
import { notifyStartupHomeReady } from "@/utils/startup-readiness";
import { shouldShowHomeGallery } from "./-home-gallery-state";
import {
  loadSortField,
  loadSortOrder,
  saveSortPreference,
} from "./home-sort-storage";

type PhotoPagesData = InfiniteData<PhotoListResponse>;

const SEARCH_MODES: SearchMode[] = ["text", "image", "exif", "color"];
const EMPTY_PHOTOS: Photo[] = [];
const NO_PHOTO_IDS: number[] = [];
const RESTORE_OVERLAY_FADE_MS = 180;
const RESTORE_OVERLAY_LABEL_DELAY_MS = 120;

function GalleryRestoreOverlay({
  active,
  label,
}: {
  active: boolean;
  label: string;
}) {
  const [rendered, setRendered] = useState(active);
  const [exiting, setExiting] = useState(false);
  const [showLabel, setShowLabel] = useState(false);

  useEffect(() => {
    if (active) {
      setRendered(true);
      setExiting(false);
      const labelTimer = setTimeout(
        () => setShowLabel(true),
        RESTORE_OVERLAY_LABEL_DELAY_MS
      );
      return () => clearTimeout(labelTimer);
    }

    setShowLabel(false);
    if (!rendered) {
      return;
    }
    setExiting(true);
    const exitTimer = setTimeout(() => {
      setRendered(false);
      setExiting(false);
    }, RESTORE_OVERLAY_FADE_MS);
    return () => clearTimeout(exitTimer);
  }, [active, rendered]);

  if (!rendered) {
    return null;
  }

  return (
    <div
      aria-live="polite"
      className={`home-gallery-restore-overlay ${exiting ? "is-exiting" : ""}`}
      role="status"
    >
      <div
        className={`home-gallery-restore-status ${showLabel ? "is-visible" : ""}`}
      >
        <span aria-hidden="true" className="home-gallery-restore-pulse" />
        <span>{label}</span>
      </div>
    </div>
  );
}

function isSearchMode(value: string | null): value is SearchMode {
  return SEARCH_MODES.includes(value as SearchMode);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this route coordinates the existing gallery interactions
function HomePage() {
  const { t } = useTranslation();
  const compactDetailOverlay = useMediaQuery("(max-width: 1120px)");
  const detailOverlayRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const filter = useSidebarFilter();
  const { registerImageSearch } = useImportDropContext();
  // 搜索状态：从 BrowseSessionContext 恢复，导航回来时保留搜索上下文
  const { getSession: getBrowseSession, saveSession: saveBrowseSession } =
    useBrowseSession();
  const searchQuery = filter.appliedSearch?.query ?? "";
  const searchMode = filter.appliedSearch?.mode ?? null;
  const imageSearchPath = filter.appliedSearch?.imagePath ?? null;
  const searchFilters = filter.appliedSearch?.filters ?? {};
  const [showDrillBanner, setShowDrillBanner] = useState(false);
  const [drillDownFilters, setDrillDownFilters] = useState<ExifFilters>();
  const [dashboardReturnTarget, setDashboardReturnTarget] =
    useState<DashboardReturnTarget | null>(
      () => getBrowseSession("home-search").dashboardReturn ?? null
    );
  const clearDashboardReturnTarget = useCallback(() => {
    setDashboardReturnTarget(null);
    saveBrowseSession("home-search", { dashboardReturn: null });
  }, [saveBrowseSession]);
  const {
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
  } = useHomeSearch({
    filter,
    saveBrowseSession,
    navigate,
    clearDashboardReturnTarget,
    setDrillDownFilters,
    setShowDrillBanner,
  });
  const imageSearchRef = useRef(handleImageSearch);
  imageSearchRef.current = handleImageSearch;
  useEffect(
    () => registerImageSearch((imagePath) => imageSearchRef.current(imagePath)),
    [registerImageSearch]
  );
  const colorHex = filter.appliedSearch?.colorHex ?? null;
  const [lightboxIndex, setLightboxIndex] = useState(-1);
  const [sequenceMode, setSequenceMode] = useState<"photos" | "sequences">(
    () => getBrowseSession("home-search").sequenceMode
  );
  const gridRef = useRef<MasonryGridHandle>(null);
  const displayedSequenceModeRef = useRef<"photos" | "sequences">("photos");
  const gallerySurfaceRef = useRef<HTMLDivElement>(null);
  const galleryScrollPositionsRef = useRef<
    Record<"photos" | "sequences", number>
  >({
    photos: 0,
    sequences: 0,
  });
  const galleryScrollRouteKeyRef = useRef<string | null>(null);
  const pendingModeScrollRestoreRef = useRef<"photos" | "sequences" | null>(
    null
  );
  const modeScrollRestoreIdRef = useRef(0);
  const [modeScrollRestore, setModeScrollRestore] = useState<{
    id: number;
    mode: "photos" | "sequences";
    routeKey: string | null;
    scrollTop: number;
  } | null>(null);
  const isSearching = searchMode !== null;
  const sequencePhotoIds = useMemo(
    () =>
      isSearching
        ? (searchResults ?? EMPTY_PHOTOS).map((photo) => photo.id)
        : NO_PHOTO_IDS,
    [isSearching, searchResults]
  );
  const {
    sequenceDataSource,
    setSequenceRetry,
    sequences,
    setSequences,
    sequenceError,
    gallerySequenceCount,
    sequenceRefresh,
    setSequenceRefresh,
    sequenceQuerySourceKey,
    sequenceViewReady,
    sequenceCount,
  } = useHomeSequenceQuery({
    filter,
    isSearching,
    searchResultGeneration,
    searchResultSourceKey,
    sequencePhotoIds,
  });
  const {
    openSequence,
    setOpenSequence,
    sequenceAutoPlay,
    setSequenceAutoPlay,
    expandedSequence,
    setExpandedSequence,
    expandedSequenceComplete,
    setExpandedSequenceComplete,
    expandingSequenceId,
    setExpandingSequenceId,
    expandedSequenceCacheRef,
    expandSequenceRequestRef,
    sequenceDetailsRequestRef,
    selectedSequence,
    setSelectedSequence,
    sequenceReturnTarget,
    setSequenceReturnTarget,
    sequenceDetailsLoading,
    setSequenceDetailsLoading,
    handleSequenceOrderChange,
    handleOpenSequence,
    handleOpenSequenceDetails,
    handleToggleSequenceExpand,
  } = useHomeSequenceDetails({
    isSearching,
    sequenceRefresh,
    sequences,
    setSequences,
  });

  const suggestionState = useSequenceSuggestions(
    filter.activeFolderId ?? undefined
  );
  const sequenceSuggestions = suggestionState.suggestions;
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const suggestionsTriggerRef = useRef<HTMLButtonElement>(null);
  const {
    rebuildingSequences,
    sequenceRebuildPreview,
    setSequenceRebuildPreview,
    pendingSequenceAction,
    setPendingSequenceAction,
    handleRebuildSequences,
    confirmSequenceRebuild,
    confirmSequenceAction,
    handleSplitSequence,
    handleSetSequenceRepresentative,
  } = useHomeSequenceActions({
    activeFolderId: filter.activeFolderId,
    setSelectedSequence,
    setSequenceRefresh,
    handleOpenSequenceDetails,
  });

  const [ctxMenu, setCtxMenu] = useState<MenuState>({
    open: false,
    x: 0,
    y: 0,
    photoId: null,
    photoPath: null,
    isBatch: false,
    selectionCount: 0,
  });
  const [sortField, setSortField] = useState<SortField>(loadSortField);
  const [sortOrder, setSortOrder] = useState<SortOrder>(loadSortOrder);
  const [gridColumnWidth, setGridColumnWidth] = useState(loadGridColumnWidth);
  const [galleryToolbarHeight, setGalleryToolbarHeight] = useState(52);
  const [galleryScrolled, setGalleryScrolled] = useState(false);
  const [detailPanelWidth, setDetailPanelWidth] = useState(
    loadPhotoDetailPanelWidth
  );
  const galleryToolbarRef = useRef<HTMLDivElement>(null);
  const [quickPreviewIndex, setQuickPreviewIndex] = useState(-1);

  // Drill-down from dashboard: detect search params and auto-trigger EXIF search
  const drillParams = Route.useSearch();
  const drillConsumed = useRef(false);

  const resetDrillDown = useCallback(() => {
    filter.setSearchDraftFilters({});
    filter.clearSearch();
    setDrillDownFilters(undefined);
    setShowDrillBanner(false);
    clearDashboardReturnTarget();
  }, [
    clearDashboardReturnTarget,
    filter.clearSearch,
    filter.setSearchDraftFilters,
  ]);

  useEffect(() => {
    const onTagsChanged = () => {
      // Text search includes tag evidence. Restart at page one; performSearch
      // advances the existing generation guard before its first async request.
      if (
        searchMode !== null &&
        searchMode !== "image" &&
        lastSearchParamsRef.current?.query.trim()
      ) {
        handleSearchRetry();
      }
      // Only tag-filtered browse queries depend on this mutation. Cancel any
      // in-flight fetch before refetching so its old membership cannot win.
      const taggedQueries = {
        queryKey: ["photos"],
        predicate: (query: { queryKey: readonly unknown[] }) => {
          const scope = query.queryKey[1] as
            | { tagId?: number | null; tagIds?: number[] | null }
            | undefined;
          return Boolean(scope?.tagId || scope?.tagIds?.length);
        },
      };
      queryClient.cancelQueries(taggedQueries).then(() => {
        queryClient.invalidateQueries(taggedQueries);
      });
    };
    window.addEventListener("tags-changed", onTagsChanged);
    return () => window.removeEventListener("tags-changed", onTagsChanged);
  }, [handleSearchRetry, searchMode, lastSearchParamsRef]);

  const handledSearchResetVersion = useRef(filter.searchResetVersion);
  useLayoutEffect(() => {
    if (handledSearchResetVersion.current === filter.searchResetVersion) {
      return;
    }
    handledSearchResetVersion.current = filter.searchResetVersion;
    resetHomeSearchState();
  }, [filter.searchResetVersion, resetHomeSearchState]);

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: drill-down state transitions intentionally stay atomic
  useEffect(() => {
    const hasParams = Object.entries(drillParams).some(
      ([key, value]) => key !== "dashboardReturn" && value !== undefined
    );

    if (!hasParams) {
      // 钻取参数会在触发搜索后从 URL 移除；此时保留本次钻取的
      // 提示条和返回目标，直到用户主动清除筛选或开始新的搜索。
      if (!drillConsumed.current) {
        setShowDrillBanner(false);
      }
      return;
    }

    if (drillConsumed.current) {
      return;
    }
    drillConsumed.current = true;

    // Handle reset from SpotlightSearch "All Photos"
    if (drillParams.reset) {
      resetHomeSearchState();
      filter.setActiveFolderId(null); // also clears favoriteOnly + activeTagIds
      return;
    }

    // Handle tagId navigation from SpotlightSearch
    if (drillParams.tagId != null) {
      clearDashboardReturnTarget();
      const tagId = drillParams.tagId;
      navigate({ to: "/", search: {}, replace: true });
      setSearchTime(undefined);
      setSearchResults(null);
      filter.setFavoriteOnly(false);
      filter.setActiveFolderId(null);
      // Set tag filter via Context — need to set activeTagIds directly
      // No direct setter exposed; use toggleTag for single tag
      filter.toggleTag(tagId);
      // 确保 usePhotos 在 tagId 变化后立即重新查询
      queryClient.invalidateQueries({
        queryKey: ["photos"],
        refetchType: "active",
      });
      return;
    }

    // Handle favoriteOnly navigation from SpotlightSearch
    if (drillParams.favoriteOnly) {
      clearDashboardReturnTarget();
      navigate({ to: "/", search: {}, replace: true });
      setSearchTime(undefined);
      setSearchResults(null);
      filter.setFavoriteOnly(true); // also clears activeFolderId + activeTagIds
      return;
    }

    setShowDrillBanner(true);
    const dashboardReturnTarget = parseDashboardReturnTarget(
      drillParams.dashboardReturn
    );
    setDashboardReturnTarget(dashboardReturnTarget);
    saveBrowseSession("home-search", {
      dashboardReturn: dashboardReturnTarget,
    });

    // Build filters
    const filters: ExifFilters = {};
    if (drillParams.advancedField && drillParams.advancedValue) {
      filters.advancedField =
        drillParams.advancedField as ExifFilters["advancedField"];
      filters.advancedValue = drillParams.advancedValue;
    }
    if (drillParams.cameraModel) {
      filters.cameraModel = drillParams.cameraModel;
    }
    if (drillParams.creator) {
      filters.creator = drillParams.creator;
    }
    if (drillParams.lensModel) {
      filters.lensModel = drillParams.lensModel;
    }
    if (drillParams.focalMin) {
      filters.focalMin = drillParams.focalMin;
    }
    if (drillParams.focalMax) {
      filters.focalMax = drillParams.focalMax;
    }
    if (drillParams.apertureMin) {
      filters.apertureMin = drillParams.apertureMin;
    }
    if (drillParams.apertureMax) {
      filters.apertureMax = drillParams.apertureMax;
    }
    if (drillParams.isoMin) {
      filters.isoMin = drillParams.isoMin;
    }
    if (drillParams.isoMax) {
      filters.isoMax = drillParams.isoMax;
    }
    if (drillParams.shutterMin) {
      filters.shutterMin = drillParams.shutterMin;
    }
    if (drillParams.shutterMax) {
      filters.shutterMax = drillParams.shutterMax;
    }
    if (drillParams.dateFrom) {
      filters.dateFrom = drillParams.dateFrom;
    }
    if (drillParams.dateMonth) {
      filters.dateMonth = drillParams.dateMonth;
    }
    if (drillParams.dateHour) {
      filters.dateHour = drillParams.dateHour;
    }
    if (drillParams.dateTo) {
      filters.dateTo = drillParams.dateTo;
    }

    // Extract optional text search query and color hex for color drill-down
    const textQuery = (drillParams.searchQuery as string) || "";
    const colorHexParam = (drillParams.colorHex as string) || undefined;

    setDrillDownFilters(filters);

    // Clear URL params and trigger search
    navigate({ to: "/", search: {}, replace: true });
    handleSearch(textQuery, filters, colorHexParam, true);
  }, [
    drillParams,
    navigate,
    filter.setFavoriteOnly,
    filter.toggleTag,
    filter.setActiveFolderId,
    saveBrowseSession,
    resetHomeSearchState,
    handleSearch,
    clearDashboardReturnTarget,
    setSearchTime,
    setSearchResults,
  ]);

  const sequenceRevisionRef = useRef(0);
  // Listen for file-change events from main process (chokidar watcher)
  useEffect(() => {
    const handleSequenceMessage = (event: MessageEvent) => {
      if (event.data?.channel !== "sequences-changed") {
        return;
      }
      if (typeof event.data.revision === "number") {
        if (event.data.revision <= sequenceRevisionRef.current) {
          return;
        }
        sequenceRevisionRef.current = event.data.revision;
      }
      expandSequenceRequestRef.current += 1;
      sequenceDetailsRequestRef.current += 1;
      setExpandingSequenceId(null);
      queryClient.invalidateQueries({
        queryKey: ["photos"],
        refetchType: "active",
      });
      if (
        event.data.reason === "reorder" &&
        typeof event.data.sequenceId === "number" &&
        Array.isArray(event.data.orderedMemberIds)
      ) {
        handleSequenceOrderChange({
          orderedMemberIds: event.data.orderedMemberIds,
          sequenceId: event.data.sequenceId,
        });
      }
      expandedSequenceCacheRef.current.clear();
      setSequenceRefresh((value) => value + 1);
    };
    const handler = (event: MessageEvent) => {
      if (event.data?.channel === "file-change") {
        // refetchType: "active" — 仅重取当前视口活跃的页面，
        // 杜绝 chokidar 事件触发所有已加载页（如 50 页）同时 IPC 请求的雪崩
        queryClient.invalidateQueries({
          queryKey: ["photos"],
          refetchType: "active",
        });
        queryClient.invalidateQueries({ queryKey: ["folders"] });
        clearImageLoadCache();
      }
      if (event.data?.channel === "ai-auto-repair-started") {
        toast.info(t("aiAutoRepairStarted"));
      }
      if (event.data?.channel === "ai-embedding-done") {
        queryClient.invalidateQueries({ queryKey: ["aiStatus"] });
      }
      if (event.data?.channel === "ai-status-changed") {
        queryClient.invalidateQueries({ queryKey: ["aiStatus"] });
      }
      handleSequenceMessage(event);
    };
    window.addEventListener("message", handler);
    return () => {
      window.removeEventListener("message", handler);
    };
  }, [
    handleSequenceOrderChange,
    t,
    expandSequenceRequestRef,
    sequenceDetailsRequestRef,
    setExpandingSequenceId,
    expandedSequenceCacheRef,
    setSequenceRefresh,
  ]);

  const {
    data: photosData,
    fetchNextPage,
    hasNextPage,
    isLoading: photosLoading,
    isFetching: photosFetching,
    isFetchingNextPage,
    isPlaceholderData: photosIsPlaceholder,
    error: photosError,
    refetch: refetchPhotos,
  } = usePhotos({
    folderId: filter.activeFolderId,
    tagIds: filter.activeTagIds.length > 0 ? filter.activeTagIds : undefined,
    tagMode: filter.tagMode,
    favoriteOnly: filter.favoriteOnly || undefined,
    ungroupedOnly: sequenceMode === "photos",
    sort: sortField,
    order: sortOrder,
    enabled: !isSearching,
  });
  const {
    data: foldersData,
    error: foldersError,
    isFetching: foldersFetching,
    isLoading: foldersLoading,
    refetch: refetchFolders,
  } = useFolders();
  const folders = foldersData ?? [];
  const globalAiStatus = useGlobalAiStatus();

  const { data: aiStatus } = useAiStatus();
  const previousCoverageStateRef = useRef(aiStatus?.coverageState);

  useEffect(() => {
    const previous = previousCoverageStateRef.current;
    previousCoverageStateRef.current = aiStatus?.coverageState;
    const pending = pendingSemanticRefreshRef.current;
    if (
      aiStatus?.coverageState !== "ready" ||
      previous === "ready" ||
      !pending ||
      pending.generation !== searchGenerationRef.current ||
      searchMode !== "text" ||
      searchQuery !== pending.query
    ) {
      return;
    }
    pendingSemanticRefreshRef.current = null;
    handleSearch(pending.query, pending.filters, pending.colorHex, true);
  }, [
    aiStatus?.coverageState,
    searchMode,
    searchQuery,
    handleSearch,
    pendingSemanticRefreshRef,
    searchGenerationRef,
  ]);

  // Flatten paginated photos
  const pagedPhotos = useMemo(
    () => photosData?.pages.flatMap((p) => p.items) ?? EMPTY_PHOTOS,
    [photosData]
  );
  const totalFromQuery = photosData?.pages[0]?.total ?? 0;
  const totalAllFromQuery = photosData?.pages[0]?.totalAll ?? totalFromQuery;
  const initialHomeQueryError =
    !isSearching &&
    Boolean(
      (photosError && photosData === undefined) ||
        (foldersError && foldersData === undefined)
    );
  const handleHomeDataRetry = useCallback(() => {
    refetchPhotos().catch(() => undefined);
    refetchFolders().catch(() => undefined);
  }, [refetchFolders, refetchPhotos]);

  useEffect(() => {
    recordGalleryPerf("galleryPagedPhotoCount", pagedPhotos.length);
    recordGalleryPerf("galleryLoadedPageCount", photosData?.pages.length ?? 0);
  }, [pagedPhotos.length, photosData?.pages.length]);

  const THUMBNAIL_BACKFILL_BATCH_SIZE = 4;
  const THUMBNAIL_BACKFILL_DELAY_MS = 6000;
  const THUMBNAIL_BACKFILL_IDLE_TIMEOUT_MS = 4000;
  const thumbnailBackfillQueuedRef = useRef<Set<number>>(new Set());

  // Active photo list: search results or paginated query.
  // Search results render from the committed response immediately so the
  // request state and masonry input cannot drift apart. Ordinary browse lists
  // still use a deferred copy to avoid blocking on very large transitions.
  const rawPhotos = isSearching ? (searchResults ?? EMPTY_PHOTOS) : pagedPhotos;
  const lastSearchPhotosRef = useRef<Photo[] | null>(null);
  const resolvedRawPhotos = useMemo(
    () =>
      isSearching
        ? getSequenceResolvedPhotos({
            photos: rawPhotos,
            generation: searchResultGeneration,
            resolvedGeneration: sequenceDataSource?.searchGeneration ?? null,
            resolvedIds: sequenceDataSource?.photoIds ?? [],
          })
        : rawPhotos,
    [isSearching, rawPhotos, searchResultGeneration, sequenceDataSource]
  );
  // Search results are already committed immediately below. Deferring their
  // unused copy would schedule another HomePage render for every response.
  const deferredPhotos = useDeferredValue(pagedPhotos);
  if (isSearching) {
    lastSearchPhotosRef.current = resolvedRawPhotos;
  }
  // Search responses use their resolved array immediately; browse transitions
  // use the deferred paginated gallery, including after search is cleared.
  const useImmediateGalleryPhotos = shouldUseImmediateGalleryPhotos({
    deferredPhotos,
    isSearching,
    lastSearchPhotos: lastSearchPhotosRef.current,
    rawPhotos,
  });
  const photos = useImmediateGalleryPhotos ? resolvedRawPhotos : deferredPhotos;
  // Only show stale overlay when the data *source* changes (search↔browse),
  // not during pagination or in-place refreshes.
  const prevIsSearching = useRef(isSearching);
  const isPhotosStale =
    rawPhotos !== photos && prevIsSearching.current !== isSearching;
  prevIsSearching.current = isSearching;
  const actionPhotos = useMemo(() => {
    const existingIds = new Set(photos.map((photo) => photo.id));
    const additional = [
      ...sequences.flatMap((sequence) => [
        sequence.photo,
        ...(sequence.matchedPhoto ? [sequence.matchedPhoto] : []),
      ]),
      ...(expandedSequence?.members ?? []),
    ];
    return [
      ...photos,
      ...additional.filter((photo) => {
        if (existingIds.has(photo.id)) {
          return false;
        }
        existingIds.add(photo.id);
        return true;
      }),
    ];
  }, [photos, expandedSequence, sequences]);
  const photosRef = useRef(actionPhotos);
  photosRef.current = actionPhotos;
  const [displayedSequenceMode, setDisplayedSequenceMode] = useState<
    "photos" | "sequences"
  >("photos");
  const requestedDisplayedSequenceMode = getDisplayedSequenceMode(
    sequenceMode,
    sequenceViewReady &&
      (isSearching || (!photosIsPlaceholder && rawPhotos === photos)),
    displayedSequenceMode
  );
  const commitDisplayedSequenceMode = useCallback(
    (nextMode: "photos" | "sequences") => {
      if (displayedSequenceModeRef.current === nextMode) {
        return;
      }
      startGalleryViewTransition(() => {
        displayedSequenceModeRef.current = nextMode;
        setDisplayedSequenceMode(nextMode);
      }, gallerySurfaceRef.current);
    },
    []
  );
  useEffect(() => {
    commitDisplayedSequenceMode(requestedDisplayedSequenceMode);
  }, [commitDisplayedSequenceMode, requestedDisplayedSequenceMode]);
  useEffect(
    () => () => {
      cancelGalleryViewTransition();
    },
    []
  );
  // The masonry end sentinel is based on the currently rendered items. When
  // switching to the usually shorter sequence view it immediately intersects,
  // so browse mode must not paginate its underlying photo list. Search must
  // still consume later result pages to discover their matching sequences.
  const isPhotoPaginationActive = canPaginateGalleryPhotos(
    sequenceMode,
    isSearching ? searchHasMore : Boolean(hasNextPage),
    isSearching
  );
  const handleSequenceModeChange = useCallback(
    (mode: "photos" | "sequences") => {
      const currentMode = displayedSequenceModeRef.current;
      if (mode === sequenceMode) {
        return;
      }
      const scrollElement = gridRef.current?.scrollElement;
      if (
        scrollElement &&
        pendingModeScrollRestoreRef.current !== currentMode
      ) {
        galleryScrollPositionsRef.current[currentMode] =
          scrollElement.scrollTop;
      }
      pendingModeScrollRestoreRef.current = mode;
      modeScrollRestoreIdRef.current += 1;
      setModeScrollRestore({
        id: modeScrollRestoreIdRef.current,
        mode,
        routeKey: galleryScrollRouteKeyRef.current,
        scrollTop: galleryScrollPositionsRef.current[mode],
      });
      setSequenceMode(mode);
      saveBrowseSession("home-search", { sequenceMode: mode });
    },
    [saveBrowseSession, sequenceMode]
  );

  useEffect(() => {
    const missingIds: number[] = [];
    for (const photo of rawPhotos) {
      if (
        photo.thumbnailPath ||
        thumbnailBackfillQueuedRef.current.has(photo.id)
      ) {
        continue;
      }
      thumbnailBackfillQueuedRef.current.add(photo.id);
      missingIds.push(photo.id);
      if (missingIds.length >= THUMBNAIL_BACKFILL_BATCH_SIZE) {
        break;
      }
    }
    if (missingIds.length === 0) {
      return;
    }

    let cancelled = false;
    let idleHandle: number | null = null;
    const runBackfill = () => {
      recordGalleryPerf("thumbnailBackfillQueuedIds", missingIds.length);
      ipc.client.photos
        .backfillMissingThumbnails({
          ids: missingIds,
          limit: THUMBNAIL_BACKFILL_BATCH_SIZE,
        })
        .then((result) => {
          if (cancelled) {
            return;
          }
          const updated = result.updated ?? [];
          recordGalleryPerf("thumbnailBackfillUpdated", updated.length);
          if (updated.length === 0) {
            return;
          }
          const thumbnailPathById = new Map(
            updated.map((item) => [item.id, item])
          );
          setSearchResults(
            (current) =>
              current?.map((photo) => {
                const updatedPhoto = thumbnailPathById.get(photo.id);
                return updatedPhoto
                  ? {
                      ...photo,
                      thumbnailPath: updatedPhoto.thumbnailPath,
                      thumbnailSmallPath: updatedPhoto.thumbnailSmallPath,
                    }
                  : photo;
              }) ?? current
          );
          queryClient.setQueriesData<PhotoPagesData>(
            { queryKey: ["photos"] },
            (data) => {
              if (!data?.pages) {
                return data;
              }
              let changed = false;
              const pages = data.pages.map((page) => ({
                ...page,
                items: page.items.map((photo) => {
                  const updatedPhoto = thumbnailPathById.get(photo.id);
                  if (!updatedPhoto) {
                    return photo;
                  }
                  changed = true;
                  return {
                    ...photo,
                    thumbnailPath: updatedPhoto.thumbnailPath,
                    thumbnailSmallPath: updatedPhoto.thumbnailSmallPath,
                  };
                }),
              }));
              return changed ? { ...data, pages } : data;
            }
          );
        })
        .catch(() => {
          for (const id of missingIds) {
            thumbnailBackfillQueuedRef.current.delete(id);
          }
        });
    };
    const timer = window.setTimeout(() => {
      const idleWindow = window as Window & {
        cancelIdleCallback?: (handle: number) => void;
        requestIdleCallback?: (
          callback: () => void,
          options?: { timeout: number }
        ) => number;
      };
      if (idleWindow.requestIdleCallback) {
        idleHandle = idleWindow.requestIdleCallback(runBackfill, {
          timeout: THUMBNAIL_BACKFILL_IDLE_TIMEOUT_MS,
        });
      } else {
        idleHandle = window.setTimeout(runBackfill, 1000);
      }
    }, THUMBNAIL_BACKFILL_DELAY_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (idleHandle !== null) {
        const idleWindow = window as Window & {
          cancelIdleCallback?: (handle: number) => void;
        };
        if (idleWindow.cancelIdleCallback) {
          idleWindow.cancelIdleCallback(idleHandle);
        } else {
          window.clearTimeout(idleHandle);
        }
      }
      for (const id of missingIds) {
        thumbnailBackfillQueuedRef.current.delete(id);
      }
    };
  }, [rawPhotos, setSearchResults]);

  // 持久化搜索状态 + 挂载时自动重新搜索
  const searchStateRef = useRef({
    colorHex,
    filters: searchFilters,
    imageSearchPath,
    searchMode,
    searchQuery,
  });
  searchStateRef.current = {
    colorHex,
    filters: searchFilters,
    imageSearchPath,
    searchMode,
    searchQuery,
  };
  useEffect(() => {
    return () => {
      saveBrowseSession("home-search", {
        searchQuery: searchStateRef.current.searchQuery,
        searchMode: searchStateRef.current.searchMode,
        colorHex: searchStateRef.current.colorHex,
        filters: searchStateRef.current.filters,
        imageSearchPath: searchStateRef.current.imageSearchPath,
      });
    };
  }, [saveBrowseSession]);

  // 挂载时如果有保存的搜索，等 AI 模型就绪后自动重新搜索
  const aiStatusRef = useRef(aiStatus);
  aiStatusRef.current = aiStatus;
  const restoredSearchRef = useRef(false);
  useEffect(() => {
    // 如果 URL 已有钻取参数（如从仪表盘色块点击），跳过恢复：
    // 钻取参数优先于 sessionStorage，否则旧颜色会 setTimeout 覆盖新钻取结果。
    const hasDrillParams = Object.values(drillParams).some(
      (v) => v !== undefined
    );
    if (
      !shouldRestoreSavedSearch({
        drillConsumed: drillConsumed.current,
        hasDrillParams,
        restored: restoredSearchRef.current,
      })
    ) {
      return;
    }
    const saved = getBrowseSession("home-search");
    if (saved.searchMode === "image") {
      restoredSearchRef.current = true;
      if (!saved.imageSearchPath) {
        resetHomeSearchState();
        return;
      }
      const restoredImagePath = saved.imageSearchPath;
      let attempts = 0;
      const tryImageSearch = () => {
        attempts++;
        if (aiStatusRef.current?.hasVectors !== undefined || attempts > 100) {
          imageSearchRef.current(restoredImagePath);
        } else {
          setTimeout(tryImageSearch, 100);
        }
      };
      setTimeout(tryImageSearch, 300);
      return;
    }
    const hasSavedFilters = Object.values(saved.filters).some((value) =>
      Boolean(value)
    );
    if (
      saved.searchQuery ||
      saved.searchMode === "color" ||
      saved.colorHex ||
      hasSavedFilters
    ) {
      restoredSearchRef.current = true;
      const q = saved.searchQuery;
      const restoredMode = isSearchMode(saved.searchMode)
        ? saved.searchMode
        : resolveSearchMode(q, saved.colorHex);
      filter.applySearch({
        colorHex: saved.colorHex ?? undefined,
        filters: saved.filters,
        mode: restoredMode,
        query: q,
      });
      // 等 AI 模型就绪后自动触发搜索（轮询检测，最多等 10s）
      let attempts = 0;
      const trySearch = () => {
        attempts++;
        if (aiStatusRef.current?.hasVectors !== undefined || attempts > 100) {
          handleSearch(
            q,
            saved.filters,
            saved.colorHex ?? undefined,
            saved.dashboardReturn !== null
          );
        } else {
          setTimeout(trySearch, 100);
        }
      };
      setTimeout(trySearch, 300);
    }
  }, [
    getBrowseSession,
    handleSearch,
    drillParams,
    filter.applySearch,
    resetHomeSearchState,
  ]); // 仅首次挂载

  // 动态 routeKey：区分搜索/筛选/排序状态
  // ⚠️ 所有 filter 字段必须做 ?? fallback，防止卸载期 SidebarFilterContext
  // 重置导致 "undefined" 字符串窜入 Key（如 home-all-undefined vs home-all）
  const { clearScrollPosition, markRouteDirty } = useScrollPosition();
  // Follow the committed result source so editing a query while its old
  // result remains visible does not start another restoration cycle.
  const routeKey = useMemo(() => {
    const filterPart = [
      filter.activeFolderId ?? "all",
      (filter.activeTagIds ?? []).join(","),
      (filter.favoriteOnly ?? false) ? "fav" : "",
      sortField ?? "date",
      sortOrder ?? "desc",
    ]
      .filter(Boolean)
      .join("-");
    const searchPart = isSearching
      ? `search-${searchResultSourceKey ?? "pending"}`
      : "";
    return `home-${filterPart}${searchPart}`;
  }, [
    isSearching,
    searchResultSourceKey,
    filter.activeFolderId,
    filter.activeTagIds,
    filter.favoriteOnly,
    sortField,
    sortOrder,
  ]);

  // ── 网格 ref（用于原子化滚动定位）─────────────────────────────
  const [restoredRouteKey, setRestoredRouteKey] = useState<string | null>(null);
  const handleRestoreSettled = useCallback((settledRouteKey: string) => {
    setRestoredRouteKey(settledRouteKey);
  }, []);

  // ── 原子化预加载：数据未就位时不渲染 MasonryGrid ──────────────
  const { hasSavedPosition, preloadState } = useScrollRestorePreloader({
    routeKey,
    pageSize: 100,
    currentItemCount: pagedPhotos.length,
    hasMore: hasNextPage ?? false,
    isInitialLoading: photosLoading && pagedPhotos.length === 0,
    onTimeout: () => {
      clearScrollPosition(routeKey);
      setRestoredRouteKey(routeKey);
      toast.info(t("scrollPositionReset"), {
        duration: 2500,
      });
    },
  });
  const restoreGateReady =
    sequenceViewReady &&
    (preloadState === "positioning" ||
      preloadState === "not-needed" ||
      preloadState === "aborted");
  const restorePending = isGalleryRevealPending({
    hasSavedPosition,
    restoredRouteKey,
    routeKey,
    sequenceViewReady,
  });
  const galleryValue = useMemo(
    () => ({
      photos,
      sequences,
      mode: displayedSequenceMode,
      routeKey,
      expandedSequence,
      expandedSequenceComplete,
      expandingSequenceId,
    }),
    [
      photos,
      sequences,
      displayedSequenceMode,
      routeKey,
      expandedSequence,
      expandedSequenceComplete,
      expandingSequenceId,
    ]
  );
  const gallerySnapshot = useGallerySnapshot({
    enabled: !(isSearching || photosError || sequenceError),
    ready:
      sequenceViewReady &&
      !photosIsPlaceholder &&
      !photosLoading &&
      rawPhotos === photos &&
      displayedSequenceMode === sequenceMode,
    value: galleryValue,
  });
  // Sequence ownership can take a little longer than the photo query. Keep
  // the gallery surface visible while its own skeleton is shown; hiding the
  // entire masonry container here makes later detail-panel layout changes
  // look like a flash. A saved scroll position still uses the existing
  // restore veil until positioning has settled.
  const contentRestorePending =
    hasSavedPosition && restorePending && !gallerySnapshot.retaining;

  // 预加载期间自动推进分页加载（顺序拉取，避免并发乱序）
  useEffect(() => {
    if (
      preloadState === "preloading" &&
      hasNextPage &&
      !isFetchingNextPage &&
      !isSearching
    ) {
      recordGalleryPerf(
        "scrollRestoreFetchNextPageAtItems",
        pagedPhotos.length
      );
      fetchNextPage();
    }
  }, [
    preloadState,
    hasNextPage,
    isFetchingNextPage,
    isSearching,
    pagedPhotos.length,
    fetchNextPage,
  ]);
  const {
    selectionPhotos,
    visibleSelectionIds,
    selectionReady,
    selectedIds,
    handleSelect,
    handleSelectMany,
    addToSelection,
    handleKeyboardSelect,
    handleMarqueeSelect,
    clearSelection,
    removeFromSelection,
    selectAllIds,
    sequenceSelection,
    previewPhotos,
  } = useHomeSelection({
    routeKey,
    photos,
    actionPhotos,
    sequences,
    displayedSequenceMode,
    sequenceViewReady,
    photosIsPlaceholder,
  });
  const {
    renameDialogOpen,
    setRenameDialogOpen,
    convertDialogOpen,
    setConvertDialogOpen,
    addToAlbumOpen,
    setAddToAlbumOpen,
    addToAlbumIds,
    setAddToAlbumIds,
    exportDialogOpen,
    setExportDialogOpen,
    exportIds,
    cloudUploadOpen,
    setCloudUploadOpen,
    cloudUploadIds,
    shareDialogOpen,
    setShareDialogOpen,
    shareIds,
    deleteConfirmOpen,
    setDeleteConfirmOpen,
    cullPhotoIds,
    setCullPhotoIds,
    pendingDeleteIds,
    setPendingDeleteIds,
    pendingDeleteSequenceGroup,
    setPendingDeleteSequenceGroup,
    deletingIds,
    handleOpenExplorer,
    handleDeletePhoto,
    handleAddToAlbum,
    handleExportPhoto,
    handleExportSelected,
    handleUploadToCloud,
    handleUploadSelectedToCloud,
    handleShare,
    handleShareSelected,
    handleDeleteSelected,
    executeDelete,
    handleRenameSelected,
    handleConvertSelected,
  } = useHomePhotoActions({
    selectedIds,
    routeKey,
    isSearching,
    markRouteDirty,
    removeFromSelection,
    setSearchResults,
  }); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for photo-drop:album event from sidebar
  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent).detail as { photoIds: number[] };
      if (detail?.photoIds?.length > 0) {
        setAddToAlbumIds(detail.photoIds);
        setAddToAlbumOpen(true);
      }
    }
    window.addEventListener("photo-drop:album", handler);
    return () => window.removeEventListener("photo-drop:album", handler);
  }, [setAddToAlbumIds, setAddToAlbumOpen]);

  const applyFavoriteState = useCallback(
    (ids: number[], favorite: boolean) => {
      const targets = new Set(ids);
      const updatePhoto = (photo: Photo) =>
        targets.has(photo.id) ? { ...photo, isFavorite: favorite } : photo;
      const updateDetail = (detail: PhotoSequenceDetail | null) =>
        detail ? { ...detail, members: detail.members.map(updatePhoto) } : null;
      setSearchResults((current) => current?.map(updatePhoto) ?? current);
      setExpandedSequence(updateDetail);
      setExpandedSequenceComplete(updateDetail);
      setSelectedSequence(updateDetail);
      setOpenSequence(updateDetail);
      setSequences((current) =>
        current.map((sequence) => ({
          ...sequence,
          photo: updatePhoto(sequence.photo),
          matchedPhoto: sequence.matchedPhoto
            ? updatePhoto(sequence.matchedPhoto)
            : undefined,
        }))
      );
      expandedSequenceCacheRef.current.clear();
      sequenceSelection.updateFavorites(ids, favorite);
      queryClient.invalidateQueries({
        queryKey: ["photos"],
        refetchType: "active",
      });
    },
    [
      sequenceSelection.updateFavorites,
      setSearchResults,
      setExpandedSequence,
      setExpandedSequenceComplete,
      setSelectedSequence,
      setOpenSequence,
      setSequences,
      expandedSequenceCacheRef,
    ]
  );
  const handleBatchToggleFavorite = useHomeBatchFavorite({
    sequenceQuerySourceKey,
    displayedSequenceMode,
    selectionReady,
    selectedIds,
    sequenceSelection,
    visibleSelectionIds,
    applyFavoriteState,
  });

  const selectAllVisible = useCallback(() => {
    selectAllIds(visibleSelectionIds);
  }, [selectAllIds, visibleSelectionIds]);
  useEffect(() => {
    if (!selectionReady) {
      return;
    }
    const allowed = new Set(visibleSelectionIds);
    const hidden = [...selectedIds].filter((id) => !allowed.has(id));
    if (hidden.length > 0) {
      removeFromSelection(hidden);
    }
  }, [removeFromSelection, selectedIds, selectionReady, visibleSelectionIds]);
  const recentlyViewedContextKey = [
    routeKey,
    sequenceMode,
    sortField,
    sortOrder,
    searchQuery,
    searchMode ?? "",
    imageSearchPath ?? "",
    filter.tagMode,
    JSON.stringify(searchFilters),
  ].join("|");
  const returnDetails = useMemo(
    () => [
      expandedSequence,
      expandedSequenceComplete,
      selectedSequence,
      openSequence,
      sequenceReturnTarget,
    ],
    [
      expandedSequence,
      expandedSequenceComplete,
      selectedSequence,
      openSequence,
      sequenceReturnTarget,
    ]
  );
  const {
    recentlyViewedTarget,
    recentlyViewedPhotoId,
    recentlyViewedPulseActive,
    recentlyViewedPulseKey,
    recentlyViewedReturnRequest,
    clearRecentlyViewed,
    markRecentlyViewed,
    markSequence,
    beginSequence,
    rememberPhoto,
    settleReturn,
    stopPulse,
  } = useGalleryReturn({
    contextKey: recentlyViewedContextKey,
    photos,
    sequences,
    details: returnDetails,
    ready:
      sequenceViewReady &&
      !photosFetching &&
      !photosIsPlaceholder &&
      !searchLoading,
  });
  const dismissSequenceDetail = useCallback(() => {
    const sequence = selectedSequence;
    if (sequence) {
      markSequence(sequence.id);
    }
    sequenceDetailsRequestRef.current += 1;
    setSelectedSequence(null);
    setSequenceDetailsLoading(false);
    setSequenceReturnTarget(null);
  }, [
    selectedSequence,
    markSequence,
    sequenceDetailsRequestRef,
    setSelectedSequence,
    setSequenceDetailsLoading,
    setSequenceReturnTarget,
  ]);
  const handleKeyboardPhotoSelect = useCallback(
    (id: number) => {
      clearRecentlyViewed(id);
      handleKeyboardSelect(id);
    },
    [clearRecentlyViewed, handleKeyboardSelect]
  );
  const previousSequenceModeRef = useRef(sequenceMode);
  useEffect(() => {
    if (previousSequenceModeRef.current === sequenceMode) {
      return;
    }
    previousSequenceModeRef.current = sequenceMode;
    clearSelection();
    expandSequenceRequestRef.current += 1;
    setExpandedSequence(null);
    setExpandedSequenceComplete(null);
    setExpandingSequenceId(null);
    clearRecentlyViewed();
  }, [
    clearRecentlyViewed,
    clearSelection,
    sequenceMode,
    expandSequenceRequestRef,
    setExpandedSequence,
    setExpandedSequenceComplete,
    setExpandingSequenceId,
  ]);
  const handleScopedSequenceExpand = useCallback(
    (sequenceId: number) => {
      if (
        recentlyViewedTarget &&
        "sequenceId" in recentlyViewedTarget &&
        recentlyViewedTarget.sequenceId === sequenceId
      ) {
        stopPulse();
      } else {
        clearRecentlyViewed();
      }
      const sequence = sequences.find((item) => item.id === sequenceId);
      removeFromSelection(
        sequence?.matchedPhotoIds ?? sequence?.memberPhotoIds ?? []
      );
      handleToggleSequenceExpand(sequenceId);
    },
    [
      clearRecentlyViewed,
      handleToggleSequenceExpand,
      recentlyViewedTarget,
      stopPulse,
      removeFromSelection,
      sequences,
    ]
  );
  const handleSequenceMutationComplete = useCallback(() => {
    expandedSequenceCacheRef.current.clear();
    setExpandedSequence(null);
    setExpandedSequenceComplete(null);
    setSequenceRefresh((value) => value + 1);
    queryClient.invalidateQueries({
      queryKey: ["photos"],
      refetchType: "active",
    });
  }, [
    expandedSequenceCacheRef,
    setExpandedSequence,
    setExpandedSequenceComplete,
    setSequenceRefresh,
  ]);
  const handleSequenceRetry = useCallback(() => {
    setSequenceRetry((value) => value + 1);
  }, [setSequenceRetry]);
  const {
    detailDismissed,
    detailPhoto,
    dismissDetail,
    navigateDetail,
    showPhoto,
  } = usePhotoDetailPanel(
    selectedIds,
    previewPhotos,
    routeKey,
    handleKeyboardPhotoSelect
  );
  const dismissPhotoDetail = useCallback(() => {
    if (detailPhoto) {
      markRecentlyViewed(detailPhoto.id);
    }
    dismissDetail();
  }, [detailPhoto, dismissDetail, markRecentlyViewed]);
  // 底部操作胶囊清空选择时，详情面板也会随选中状态关闭，先记录最后查看的照片。
  const handleClearSelection = useCallback(() => {
    if (selectedSequence) {
      dismissSequenceDetail();
      dismissDetail();
    } else if (detailPhoto) {
      dismissPhotoDetail();
    } else if (!detailDismissed && selectedIds.size === 1) {
      const selectedPhotoId = selectedIds.values().next().value;
      if (
        selectedPhotoId !== undefined &&
        selectionPhotos.some((photo) => photo.id === selectedPhotoId)
      ) {
        markRecentlyViewed(selectedPhotoId);
      } else {
        clearRecentlyViewed();
      }
    }
    clearSelection();
    setSequenceReturnTarget(null);
  }, [
    selectedSequence,
    dismissSequenceDetail,
    dismissDetail,
    clearRecentlyViewed,
    clearSelection,
    detailPhoto,
    detailDismissed,
    dismissPhotoDetail,
    markRecentlyViewed,
    selectionPhotos,
    selectedIds,
    setSequenceReturnTarget,
  ]);
  useEffect(() => {
    if (
      lightboxIndex >= 0 ||
      quickPreviewIndex >= 0 ||
      openSequence ||
      selectedSequence ||
      sequenceDetailsLoading
    ) {
      clearRecentlyViewed();
    }
  }, [
    clearRecentlyViewed,
    lightboxIndex,
    openSequence,
    quickPreviewIndex,
    selectedSequence,
    sequenceDetailsLoading,
  ]);
  const handlePhotoSelect = useCallback(
    (id: number, event: React.MouseEvent) => {
      clearRecentlyViewed(id);
      setSelectedSequence(null);
      setSequenceDetailsLoading(false);
      handleSelect(id, event);
    },
    [
      clearRecentlyViewed,
      handleSelect,
      setSelectedSequence,
      setSequenceDetailsLoading,
    ]
  );
  const handleSequenceDetails = useCallback(
    (sequenceId: number) => {
      beginSequence(sequenceId);
      handleOpenSequenceDetails(sequenceId);
    },
    [beginSequence, handleOpenSequenceDetails]
  );
  const handleSequencePlayback = useCallback(
    (sequenceId: number) => {
      beginSequence(sequenceId);
      dismissDetail();
      setSequenceReturnTarget(null);
      handleOpenSequence(sequenceId);
    },
    [beginSequence, dismissDetail, handleOpenSequence, setSequenceReturnTarget]
  );
  const searchDisplayCount =
    searchExactTotal !== null &&
    !filter.activeFolderId &&
    filter.activeTagIds.length === 0 &&
    !filter.favoriteOnly
      ? searchExactTotal
      : photos.length;
  const totalPhotos = isSearching ? searchDisplayCount : totalAllFromQuery;
  const loading = isSearching
    ? searchLoading
    : photosLoading ||
      (initialHomeQueryError && (photosFetching || foldersFetching)) ||
      !sequenceViewReady;
  const startupHomeReadyRef = useRef(false);

  useEffect(() => {
    if (
      startupHomeReadyRef.current ||
      loading ||
      foldersLoading ||
      (isSearching && searchResults === null)
    ) {
      return;
    }

    let firstFrame = 0;
    let secondFrame = 0;

    firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        startupHomeReadyRef.current = true;
        notifyStartupHomeReady();
      });
    });

    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [foldersLoading, isSearching, loading, searchResults]);

  const showAiTaskStatus = Boolean(
    aiStatus?.isEmbedding || aiStatus?.lastError
  );
  const activeFolder = folders.find(
    (folder) => folder.id === filter.activeFolderId
  );
  let galleryContextLabel = activeFolder?.displayName ?? t("sidebarAllPhotos");
  if (filter.activeTagIds.length > 0) {
    galleryContextLabel = `${t("sidebarTags")} · ${filter.activeTagIds.length}`;
  }
  if (filter.favoriteOnly) {
    galleryContextLabel = t("favorite");
  }

  const handleGridColumnWidthChange = useCallback((width: number) => {
    setGridColumnWidth(width);
    try {
      localStorage.setItem(GRID_COLUMN_WIDTH_KEY, String(width));
    } catch {
      // Keep the in-memory preference when persistence is unavailable.
    }
  }, []);

  const handleGalleryScrollTopChange = useCallback((scrollTop: number) => {
    if (
      pendingModeScrollRestoreRef.current !== displayedSequenceModeRef.current
    ) {
      galleryScrollPositionsRef.current[displayedSequenceModeRef.current] =
        scrollTop;
    }
    setGalleryScrolled((previous) => {
      const next = scrollTop > 4;
      return previous === next ? previous : next;
    });
  }, []);

  const handleModeScrollRestored = useCallback((request: number) => {
    if (request !== modeScrollRestoreIdRef.current) {
      return;
    }
    pendingModeScrollRestoreRef.current = null;
    setModeScrollRestore((current) =>
      current?.id === request ? null : current
    );
  }, []);

  useLayoutEffect(() => {
    if (galleryScrollRouteKeyRef.current !== routeKey) {
      galleryScrollRouteKeyRef.current = routeKey;
      galleryScrollPositionsRef.current.photos = 0;
      galleryScrollPositionsRef.current.sequences = 0;
      pendingModeScrollRestoreRef.current = null;
      setModeScrollRestore(null);
    }
  }, [routeKey]);

  useEffect(() => {
    const element = galleryToolbarRef.current;
    if (!element) {
      return;
    }
    const updateHeight = () => setGalleryToolbarHeight(element.offsetHeight);
    updateHeight();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Keep Sidebar's totalPhotos display in sync
  useEffect(() => {
    filter.setTotalPhotos(totalPhotos);
  }, [totalPhotos, filter.setTotalPhotos]);

  const hasActiveExifFilters = searchMode === "exif";
  const photosModeSequenceOnlyEmpty =
    displayedSequenceMode === "photos" &&
    selectionPhotos.length === 0 &&
    (photos.length > 0 || sequenceCount > 0);
  const emptyStateContent = useMemo(() => {
    // Search results may all belong to sequences. Let PhotoGrid show the
    // mode-specific empty state instead of reporting a false search miss.
    if (photosModeSequenceOnlyEmpty) {
      return undefined;
    }
    if (isSearching) {
      return (
        <SearchEmptyState
          hasActiveFilters={hasActiveExifFilters}
          hasAiVectors={aiStatus?.hasVectors ?? false}
          indexedPhotos={searchSemantic?.indexedPhotos ?? 0}
          onClearFilters={() => {
            filter.setSearchDraftFilters({});
            setDrillDownFilters(undefined);
            if (filter.searchDraft.query.trim()) {
              handleSearch(filter.searchDraft.query, undefined);
            } else {
              filter.clearSearch();
            }
          }}
          onClearSearch={filter.clearSearch}
          onGoToAiSettings={() => navigate({ to: "/settings/ai-index" })}
          onRetry={
            searchMode === "image" ? handleImageSearchRetry : handleSearchRetry
          }
          parsedTimeFilter={parsedTimeFilter}
          query={searchQuery}
          rebuildRequired={aiStatus?.rebuildRequired}
          searchError={searchError}
          searchIncomplete={searchIncomplete}
          searchMode={searchMode}
          semanticRequired={searchSemanticRequired}
          semanticState={searchSemantic?.state}
          totalPhotos={searchSemantic?.totalPhotos ?? 0}
        />
      );
    }
    if (initialHomeQueryError) {
      return (
        <EmptyStateCard
          actions={[
            {
              label: t("retry"),
              onClick: handleHomeDataRetry,
              primary: true,
            },
          ]}
          description={t("loadFailedRetry")}
          icon={<CircleAlert aria-hidden="true" className="h-5 w-5" />}
          title={t("routeErrorTitle")}
        />
      );
    }
    if (filter.favoriteOnly) {
      return (
        <EmptyStateCard
          actions={[
            {
              label: t("emptyBrowseAll"),
              onClick: () => filter.setFavoriteOnly(false),
              primary: true,
            },
          ]}
          description={t("emptyFavoritesDescription")}
          icon={
            <svg
              aria-hidden="true"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              viewBox="0 0 24 24"
            >
              <path
                d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          }
          title={t("emptyFavoritesTitle")}
        />
      );
    }
    if (displayedSequenceMode === "sequences") {
      return (
        <EmptyStateCard
          actions={[
            {
              label: t("sequenceEmptyViewPhotos"),
              onClick: () => handleSequenceModeChange("photos"),
              primary: true,
            },
          ]}
          description={t("sequenceEmptyDescription")}
          icon={<Layers aria-hidden="true" className="h-5 w-5" />}
          title={t("sequenceEmptyTitle")}
        />
      );
    }
    if (filter.activeFolderId !== null || filter.activeTagIds.length > 0) {
      return (
        <EmptyStateCard
          actions={[
            {
              label: t("emptyBrowseAll"),
              onClick: filter.selectAllPhotos,
              primary: true,
            },
          ]}
          description={t("emptyScopeDescription")}
          icon={<Images aria-hidden="true" className="h-5 w-5" />}
          title={t("emptyScopeTitle")}
        />
      );
    }
    return undefined;
  }, [
    displayedSequenceMode,
    isSearching,
    photosModeSequenceOnlyEmpty,
    filter.favoriteOnly,
    filter.activeFolderId,
    filter.activeTagIds.length,
    filter.selectAllPhotos,
    t,
    searchMode,
    searchQuery,
    searchError,
    searchIncomplete,
    parsedTimeFilter,
    hasActiveExifFilters,
    aiStatus?.hasVectors,
    aiStatus?.rebuildRequired,
    searchSemantic?.indexedPhotos,
    searchSemanticRequired,
    searchSemantic?.state,
    searchSemantic?.totalPhotos,
    navigate,
    filter.searchDraft.query,
    filter.setSearchDraftFilters,
    handleSearch,
    handleSearchRetry,
    handleImageSearchRetry,
    initialHomeQueryError,
    handleHomeDataRetry,
    filter.setFavoriteOnly,
    filter.clearSearch,
    handleSequenceModeChange,
  ]);

  const handleEndReached = useCallback(() => {
    if (!isSearching && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    } else if (
      isSearching &&
      searchResults &&
      searchHasMore &&
      sequenceDataSource?.key === sequenceQuerySourceKey &&
      sequenceError === null &&
      !searchLoadingMoreRef.current
    ) {
      loadMoreSearchResults();
    }
  }, [
    isSearching,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    searchResults,
    searchHasMore,
    sequenceDataSource,
    sequenceQuerySourceKey,
    sequenceError,
    loadMoreSearchResults,
    searchLoadingMoreRef,
  ]);

  // A search page can be made entirely of sequence members. Since those
  // members are hidden in Photos mode, keep consuming the search cursor until
  // the gallery has enough standalone photos to fill the first viewport or the
  // backend is exhausted. The normal masonry sentinel continues pagination
  // after the initial batch has been filled.
  const searchUngroupedPhotoCount = useMemo(() => {
    if (!isSearching) {
      return 0;
    }
    const sequenceMemberIds = new Set(
      sequences.flatMap(
        (sequence) => sequence.matchedPhotoIds ?? sequence.memberPhotoIds ?? []
      )
    );
    return photos.filter((photo) => !sequenceMemberIds.has(photo.id)).length;
  }, [isSearching, photos, sequences]);

  useEffect(() => {
    if (
      !(isSearching && sequenceViewReady) ||
      sequenceDataSource?.key !== sequenceQuerySourceKey ||
      sequenceError !== null ||
      (displayedSequenceMode === "photos"
        ? searchUngroupedPhotoCount >= 100
        : sequences.length > 0) ||
      !searchHasMore ||
      searchLoadingMoreRef.current
    ) {
      return;
    }
    handleEndReached();
  }, [
    displayedSequenceMode,
    sequences.length,
    handleEndReached,
    isSearching,
    searchHasMore,
    searchUngroupedPhotoCount,
    sequenceViewReady,
    sequenceDataSource,
    sequenceQuerySourceKey,
    sequenceError,
    searchLoadingMoreRef,
  ]);

  const handleToggleFavorite = useCallback(
    async (id: number, requestedValue?: boolean) => {
      const photo = photosRef.current.find((p) => p.id === id);
      if (!photo) {
        return;
      }
      const prevVal = !!photo.isFavorite;
      const newVal = requestedValue ?? !prevVal;
      await ipc.client.photos.toggleFavorite({ ids: [id], favorite: newVal });
      // 同步更新展开的序列成员状态，因为 expandedSequence 是本地状态，
      // 不会随 TanStack Query 重新获取而更新
      setExpandedSequence((prev) => {
        if (!prev) {
          return prev;
        }
        return {
          ...prev,
          members: prev.members.map((m) =>
            m.id === id ? { ...m, isFavorite: newVal } : m
          ),
        };
      });
      setExpandedSequenceComplete((prev) => {
        if (!prev) {
          return prev;
        }
        return {
          ...prev,
          members: prev.members.map((m) =>
            m.id === id ? { ...m, isFavorite: newVal } : m
          ),
        };
      });
      queryClient.invalidateQueries({
        queryKey: ["photos"],
        refetchType: "active",
      });
      toast.success(
        newVal ? t("toastFavoriteAdded") : t("toastFavoriteRemoved"),
        {
          action: {
            label: t("toastUndo"),
            onClick: async () => {
              await ipc.client.photos.toggleFavorite({
                ids: [id],
                favorite: prevVal,
              });
              // 撤销时同步恢复序列成员状态
              setExpandedSequence((prev) => {
                if (!prev) {
                  return prev;
                }
                return {
                  ...prev,
                  members: prev.members.map((m) =>
                    m.id === id ? { ...m, isFavorite: prevVal } : m
                  ),
                };
              });
              setExpandedSequenceComplete((prev) => {
                if (!prev) {
                  return prev;
                }
                return {
                  ...prev,
                  members: prev.members.map((m) =>
                    m.id === id ? { ...m, isFavorite: prevVal } : m
                  ),
                };
              });
              queryClient.invalidateQueries({
                queryKey: ["photos"],
                refetchType: "active",
              });
            },
          },
        }
      );
    },
    [t, setExpandedSequence, setExpandedSequenceComplete]
  );

  const handleDoubleClick = useCallback(
    (id: number) => {
      const idx = previewPhotos.findIndex((p) => p.id === id);
      if (idx >= 0) {
        clearSelection();
        dismissPhotoDetail();
        setLightboxIndex(idx);
      }
    },
    [clearSelection, dismissPhotoDetail, previewPhotos]
  );
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      const card = (e.target as HTMLElement).closest(
        "[data-photo-id]"
      ) as HTMLElement | null;
      if (!card) {
        return;
      }
      const id = Number.parseInt(card.dataset.photoId || "", 10);
      const path = card.dataset.photoPath || null;
      const sequenceId = Number.parseInt(card.dataset.sequenceId || "", 10);
      if (!id) {
        return;
      }
      e.preventDefault();
      const inSelection = selectedIds.has(id);
      const isBatch = selectedIds.size > 1 && inSelection;
      const sequence = sequenceId
        ? sequences.find((item) => item.id === sequenceId)
        : undefined;
      const sequenceMemberIds =
        sequence?.matchedPhotoIds ?? sequence?.memberPhotoIds;
      setCtxMenu({
        open: true,
        x: e.clientX,
        y: e.clientY,
        photoId: id,
        photoPath: path,
        isBatch,
        selectionCount: isBatch ? selectedIds.size : 1,
        sequenceMemberIds,
      });
    },
    [selectedIds, sequences]
  );

  // Keyboard shortcuts for batch operations
  // biome-ignore lint/correctness/useExhaustiveDependencies: handler functions are intentionally excluded
  useEffect(() => {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: keyboard shortcuts intentionally share one event boundary
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        selectAllVisible();
        return;
      }

      if (e.key === "Delete" && selectedIds.size > 0) {
        e.preventDefault();
        handleDeleteSelected();
        return;
      }

      if (e.key === "F2" && selectedIds.size > 0) {
        e.preventDefault();
        setRenameDialogOpen(true);
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "E") {
        e.preventDefault();
        if (selectedIds.size > 0) {
          handleExportSelected();
        }
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "C") {
        e.preventDefault();
        if (selectedIds.size > 0) {
          setConvertDialogOpen(true);
        }
        return;
      }

      if (e.key === "Escape") {
        if (quickPreviewIndex >= 0) {
          setQuickPreviewIndex(-1);
          return;
        }
        if (renameDialogOpen) {
          setRenameDialogOpen(false);
          return;
        }
        if (convertDialogOpen) {
          setConvertDialogOpen(false);
          return;
        }
        if (selectedSequence || sequenceDetailsLoading) {
          dismissSequenceDetail();
          return;
        }
        if (detailPhoto) {
          handleClearSelection();
          setSequenceReturnTarget(null);
          return;
        }
        if (selectedIds.size > 0) {
          handleClearSelection();
          return;
        }
      }

      if (e.key === " " && selectedIds.size > 0 && quickPreviewIndex < 0) {
        e.preventDefault();
        const firstId = selectedIds.values().next().value as number;
        const idx = previewPhotos.findIndex((p) => p.id === firstId);
        if (idx >= 0) {
          setQuickPreviewIndex(idx);
        }
        return;
      }

      if (e.key === "f" && selectedIds.size > 0 && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        handleBatchToggleFavorite();
        return;
      }

      if (e.key === "i" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (detailPhoto) {
          handleClearSelection();
          setSequenceReturnTarget(null);
        } else if (selectedIds.size === 1) {
          const id = selectedIds.values().next().value as number;
          handleKeyboardPhotoSelect(id);
        }
        return;
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    selectionPhotos,
    selectedIds,
    renameDialogOpen,
    convertDialogOpen,
    quickPreviewIndex,
    previewPhotos,
    handleBatchToggleFavorite,
    detailPhoto,
    selectedSequence,
    sequenceDetailsLoading,
    dismissSequenceDetail,
    handleClearSelection,
    setSequenceReturnTarget,
    setRenameDialogOpen,
    setConvertDialogOpen,
  ]);

  const marqueeJustCompleted = useRef(false);

  const wrappedMarqueeSelect = useCallback(
    (ids: Set<number>) => {
      handleMarqueeSelect(ids);
      if (ids.size > 0) {
        marqueeJustCompleted.current = true;
      }
    },
    [handleMarqueeSelect]
  );

  const handleSortChange = useCallback((s: SortField, o: SortOrder) => {
    setSortField(s);
    setSortOrder(o);
    saveSortPreference(s, o);
  }, []);
  const handleTagSuggestionSelect = useCallback(
    (tag: { id: number }) => {
      filter.selectTags([tag.id]);
    },
    [filter.selectTags]
  );
  const handleSequenceSelect = useCallback(
    (memberIds: number[], event: React.MouseEvent) => {
      clearRecentlyViewed();
      if (event.ctrlKey || event.metaKey) {
        setSelectedSequence(null);
        setSequenceDetailsLoading(false);
        handleSelectMany(memberIds, event);
      } else {
        // 立即显示加载状态，避免照片详情→序列详情切换时的空白间隙
        setSequenceDetailsLoading(true);
        handleSelectMany(memberIds, event);
      }
    },
    [
      clearRecentlyViewed,
      handleSelectMany,
      setSelectedSequence,
      setSequenceDetailsLoading,
    ]
  );
  const handleSelectSequenceMembers = useCallback(
    (memberIds: number[], selectAll: boolean) => {
      if (selectAll) {
        addToSelection(memberIds);
      } else {
        removeFromSelection(memberIds);
      }
    },
    [addToSelection, removeFromSelection]
  );
  const handleTagFilterRemove = useCallback(
    (tagId: number) => {
      filter.toggleTag(tagId);
    },
    [filter.toggleTag]
  );

  const detailOverlayOpen = Boolean(
    detailPhoto || selectedSequence || sequenceDetailsLoading
  );
  useModalFocusTrap({
    active: compactDetailOverlay && detailOverlayOpen,
    containerRef: detailOverlayRef,
    onEscape: () => {
      if (selectedSequence || sequenceDetailsLoading) {
        dismissSequenceDetail();
        return;
      }
      dismissPhotoDetail();
      clearSelection();
      setSequenceReturnTarget(null);
    },
  });

  const hasPhotos = shouldShowHomeGallery({
    activeFolderId: filter.activeFolderId,
    activeTagCount: filter.activeTagIds.length,
    favoriteOnly: filter.favoriteOnly,
    initialQueryError: initialHomeQueryError,
    isSearching,
    loading,
    photoCount: photos.length,
    sequenceCount: gallerySequenceCount,
  });
  const isImportingFirstFolder =
    folders.length > 0 &&
    photos.length === 0 &&
    (globalAiStatus.phase === "import-queue" ||
      globalAiStatus.phase === "scanning");

  return (
    <>
      <div className="relative flex h-full min-w-0 flex-col">
        <HomeToolbar
          dashboardReturnTarget={dashboardReturnTarget}
          galleryContextLabel={galleryContextLabel}
          galleryScrolled={galleryScrolled}
          gridColumnWidth={gridColumnWidth}
          handleGridColumnWidthChange={handleGridColumnWidthChange}
          handleRebuildSequences={handleRebuildSequences}
          handleSequenceModeChange={handleSequenceModeChange}
          handleSortChange={handleSortChange}
          inert={compactDetailOverlay && detailOverlayOpen}
          onDashboardReturn={() =>
            navigate({ to: "/dashboard", search: dashboardReturnTarget ?? {} })
          }
          onRetry={
            searchMode === "image" ? handleImageSearchRetry : handleSearchRetry
          }
          onShowSuggestions={() => {
            setSuggestionsOpen(true);
            suggestionState.refresh();
          }}
          rebuildingSequences={rebuildingSequences}
          resetDrillDown={resetDrillDown}
          right={
            detailPhoto || selectedSequence || sequenceDetailsLoading
              ? detailPanelWidth
              : 0
          }
          search={{
            activeTagIds: filter.activeTagIds,
            aiStatus: aiStatus ?? null,
            colorHex: colorHex ?? undefined,
            drillDownFilters,
            filters: filter.searchDraft.filters,
            imageSearchActive: searchMode === "image",
            imageSearchReference:
              searchMode === "image" && imageSearchPath
                ? {
                    imagePath: imageSearchPath,
                    previewDataUrl: imageSearchPreviewDataUrl,
                  }
                : undefined,
            onClear: filter.clearSearch,
            onFiltersChange: filter.setSearchDraftFilters,
            onImageSearch: handleImageSearch,
            onQueryChange: filter.setSearchDraftQuery,
            onSearch: handleSearch,
            onTagRemove: handleTagFilterRemove,
            onTagSelect: handleTagSuggestionSelect,
            query: filter.searchDraft.query,
            resetVersion: filter.searchResetVersion,
            resultCount: searchMode ? searchDisplayCount : undefined,
            searchMode,
            searchTime,
            semanticDiagnostics:
              searchMode === "text" ? (searchSemantic ?? undefined) : undefined,
          }}
          searchIncomplete={searchIncomplete}
          searchSemantic={searchSemantic}
          searchSemanticRequired={searchSemanticRequired}
          sequenceCount={sequenceCount}
          sequenceMode={sequenceMode}
          showDrillBanner={showDrillBanner}
          sortField={sortField}
          sortOrder={sortOrder}
          suggestionCount={sequenceSuggestions.length}
          suggestionsTriggerRef={suggestionsTriggerRef}
          toolbarRef={galleryToolbarRef}
          totalPhotos={totalPhotos}
        />
        {hasPhotos ? (
          <div className="home-gallery-body relative flex min-h-0 flex-1">
            <div
              className="relative flex min-w-0 flex-1"
              inert={
                (compactDetailOverlay && detailOverlayOpen) ||
                gallerySnapshot.retaining
              }
            >
              <div
                className={`home-gallery-restore-content flex min-w-0 flex-1 ${
                  contentRestorePending ? "is-restoring" : ""
                }`}
                ref={gallerySurfaceRef}
              >
                <PhotoGrid
                  columnWidth={gridColumnWidth}
                  deletingIds={deletingIds}
                  emptyState={emptyStateContent}
                  expandedSequence={gallerySnapshot.value.expandedSequence}
                  expandedSequenceComplete={
                    gallerySnapshot.value.expandedSequenceComplete
                  }
                  expandingSequenceId={
                    gallerySnapshot.value.expandingSequenceId
                  }
                  gridRef={gridRef}
                  hasMore={
                    isPhotoPaginationActive && !gallerySnapshot.retaining
                  }
                  isLoadingMore={
                    isPhotoPaginationActive &&
                    (isSearching
                      ? isFetchingSearchNextPage
                      : isFetchingNextPage)
                  }
                  isPlaceholderData={
                    photosIsPlaceholder || gallerySnapshot.retaining
                  }
                  isStale={isPhotosStale}
                  loading={loading && !gallerySnapshot.retaining}
                  onBackgroundClick={() => {
                    if (marqueeJustCompleted.current) {
                      marqueeJustCompleted.current = false;
                      return;
                    }
                    handleClearSelection();
                  }}
                  onContextMenu={handleContextMenu}
                  onDoubleClick={handleDoubleClick}
                  onEndReached={handleEndReached}
                  onKeyboardSelect={handleKeyboardPhotoSelect}
                  onMarqueeSelect={wrappedMarqueeSelect}
                  onOpenSequence={handleSequencePlayback}
                  onOpenSequenceDetails={handleSequenceDetails}
                  onRestoreSettled={handleRestoreSettled}
                  onRetrySequences={handleSequenceRetry}
                  onReturnLocated={settleReturn}
                  onScrollRestored={handleModeScrollRestored}
                  onScrollTopChange={handleGalleryScrollTopChange}
                  onSelect={handlePhotoSelect}
                  onSelectSequence={handleSequenceSelect}
                  onSelectSequenceMembers={handleSelectSequenceMembers}
                  onSequenceModeChange={handleSequenceModeChange}
                  onSequenceMutationComplete={handleSequenceMutationComplete}
                  onSequenceOrderChange={handleSequenceOrderChange}
                  onToggleFavorite={handleToggleFavorite}
                  onToggleSequenceExpand={handleScopedSequenceExpand}
                  photos={gallerySnapshot.value.photos}
                  preserveOnSequenceError={
                    isSearching &&
                    sequenceDataSource?.key !== sequenceQuerySourceKey &&
                    sequenceViewReady
                  }
                  recentlyViewedPhotoId={recentlyViewedPhotoId}
                  recentlyViewedPulseActive={recentlyViewedPulseActive}
                  recentlyViewedPulseKey={recentlyViewedPulseKey}
                  recentlyViewedReturnRequest={recentlyViewedReturnRequest}
                  recentlyViewedTarget={recentlyViewedTarget}
                  restoreGateReady={
                    restoreGateReady && !gallerySnapshot.retaining
                  }
                  routeKey={gallerySnapshot.value.routeKey}
                  scrollRestoreRequest={
                    modeScrollRestore?.routeKey === routeKey &&
                    modeScrollRestore.mode === gallerySnapshot.value.mode &&
                    !gallerySnapshot.retaining
                      ? modeScrollRestore
                      : undefined
                  }
                  searchQuery={searchQuery}
                  selectedIds={selectedIds}
                  semanticTopSimilarity={searchSemantic?.topSimilarity}
                  sequenceError={sequenceError}
                  sequenceLoading={
                    !(sequenceViewReady || gallerySnapshot.retaining)
                  }
                  sequenceMode={gallerySnapshot.value.mode}
                  sequences={gallerySnapshot.value.sequences}
                  showToolbar={false}
                  sort={sortField}
                  sortOrder={sortOrder}
                  topInset={galleryToolbarHeight}
                />
              </div>
              <GalleryRestoreOverlay
                active={restorePending && !gallerySnapshot.retaining}
                key={routeKey}
                label={t(
                  hasSavedPosition
                    ? "restoringBrowsePosition"
                    : "preparingGallery"
                )}
              />
              <SelectionActionBar
                allFavorite={sequenceSelection.allFavorite}
                bottomOffset={showAiTaskStatus ? 44 : 16}
                onAddToAlbum={() => {
                  setAddToAlbumIds(Array.from(selectedIds));
                  setAddToAlbumOpen(true);
                }}
                onClearSelection={handleClearSelection}
                onConvert={() => setConvertDialogOpen(true)}
                onDelete={handleDeleteSelected}
                onExport={handleExportSelected}
                onRename={() => setRenameDialogOpen(true)}
                onShare={handleShareSelected}
                onStartCull={() => {
                  const ids = Array.from(selectedIds);
                  if (ids.length < 2) {
                    return;
                  }
                  setCullPhotoIds(ids);
                }}
                onToggleFavorite={handleBatchToggleFavorite}
                onUploadToCloud={handleUploadSelectedToCloud}
                selectedCount={selectedIds.size}
              />
            </div>
            {(detailPhoto || selectedSequence || sequenceDetailsLoading) && (
              <HomeDetailPanel
                compactDetailOverlay={compactDetailOverlay}
                detailOverlayRef={detailOverlayRef}
                detailPanelWidth={detailPanelWidth}
                onClose={() => {
                  if (selectedSequence || sequenceDetailsLoading) {
                    dismissSequenceDetail();
                    return;
                  }
                  dismissPhotoDetail();
                  clearSelection();
                  setSequenceReturnTarget(null);
                }}
                photo={{
                  onClose: () => {
                    dismissPhotoDetail();
                    clearSelection();
                    setSequenceReturnTarget(null);
                  },
                  onNavigate: navigateDetail,
                  onOpenExplorer: handleOpenExplorer,
                  onReturnToSequence: sequenceReturnTarget
                    ? () => {
                        if (detailPhoto) {
                          rememberPhoto(
                            detailPhoto.id,
                            sequenceReturnTarget.id
                          );
                        }
                        dismissDetail();
                        clearSelection();
                        setSelectedSequence(sequenceReturnTarget);
                        setSequenceReturnTarget(null);
                      }
                    : undefined,
                  onWidthChange: setDetailPanelWidth,
                  photo: detailPhoto,
                }}
                sequence={{
                  onClose: dismissSequenceDetail,
                  onDeleteManual: (id) => {
                    setPendingSequenceAction({ id, type: "ungroup" });
                  },
                  onOpenPhoto: (photoId) => {
                    const member = selectedSequence?.members.find(
                      (m) => m.id === photoId
                    );
                    if (selectedSequence) {
                      rememberPhoto(photoId, selectedSequence.id);
                    }
                    setSequenceReturnTarget(selectedSequence);
                    setSelectedSequence(null);
                    handleKeyboardPhotoSelect(photoId);
                    // 直接设置详情照片，确保即使照片不在 actionPhotos 中也能显示
                    if (member) {
                      showPhoto(member);
                    }
                  },
                  onPlay: () => {
                    setSequenceAutoPlay(true);
                    setOpenSequence(selectedSequence);
                  },
                  onRestoreAutomatic: (id) => {
                    setPendingSequenceAction({ id, type: "restore" });
                  },
                  onSetRepresentative: handleSetSequenceRepresentative,
                  onSplit: handleSplitSequence,
                  onWidthChange: setDetailPanelWidth,
                  sequence: selectedSequence,
                  width: detailPanelWidth,
                }}
                sequenceActive={Boolean(
                  selectedSequence || sequenceDetailsLoading
                )}
              />
            )}
          </div>
        ) : (
          <div
            className="home-gallery-body flex min-h-0 flex-1"
            style={{ paddingTop: galleryToolbarHeight }}
          >
            <Welcome
              isImporting={isImportingFirstFolder}
              onAddFolder={filter.handleAddFolder}
            />
          </div>
        )}
        {showAiTaskStatus && (
          <StatusBar
            aiStatus={aiStatus ?? null}
            className="home-gallery-status-bar absolute right-0 bottom-0 left-0 z-50"
            selectedCount={selectedIds.size}
            totalPhotos={totalPhotos}
          />
        )}
      </div>
      <ConfirmDialog
        confirmText={t("sequenceRebuildAction")}
        description={
          sequenceRebuildPreview ? (
            <span className="block space-y-2">
              <span className="block">
                {t("sequenceRebuildDescription", {
                  existing: sequenceRebuildPreview.existingAutomatic,
                  next: sequenceRebuildPreview.nextAutomatic,
                  timelapse: sequenceRebuildPreview.timelapseSegments,
                })}
              </span>
              {sequenceRebuildPreview.skipped && (
                <span className="block">
                  {t("sequenceDetectionSkipped", {
                    time: sequenceRebuildPreview.skipped.missingCaptureTime,
                    device: sequenceRebuildPreview.skipped.missingDevice,
                    hash: sequenceRebuildPreview.skipped.missingHash,
                  })}
                </span>
              )}
            </span>
          ) : undefined
        }
        onCancel={() => setSequenceRebuildPreview(null)}
        onConfirm={confirmSequenceRebuild}
        open={sequenceRebuildPreview !== null}
        title={t("sequenceRebuildConfirmTitle")}
      />
      <SequenceSuggestionsDialog
        folderScoped={filter.activeFolderId != null}
        key={filter.activeFolderId ?? "all"}
        onOpenChange={setSuggestionsOpen}
        onOpenSequence={handleOpenSequenceDetails}
        onReturnFocus={() => suggestionsTriggerRef.current?.focus()}
        open={suggestionsOpen}
        state={suggestionState}
      />
      <ConfirmDialog
        confirmText={
          pendingSequenceAction?.type === "restore"
            ? t("sequenceRestoreAutomatic")
            : t("sequenceUngroupAction")
        }
        description={
          pendingSequenceAction?.type === "restore"
            ? t("sequenceRestoreDescription")
            : t("sequenceUngroupDescription")
        }
        destructive={pendingSequenceAction?.type === "ungroup"}
        onCancel={() => setPendingSequenceAction(null)}
        onConfirm={confirmSequenceAction}
        open={pendingSequenceAction !== null}
        title={
          pendingSequenceAction?.type === "restore"
            ? t("sequenceRestoreAutomatic")
            : t("sequenceUngroupAction")
        }
      />
      {lightboxIndex >= 0 && (
        <PhotoLightbox
          initialIndex={lightboxIndex}
          modalOpen={addToAlbumOpen}
          onAddToAlbum={handleAddToAlbum}
          onClose={({ photoId }) => {
            setLightboxIndex(-1);
            markRecentlyViewed(photoId);
          }}
          onToggleFavorite={handleToggleFavorite}
          open={lightboxIndex >= 0}
          photos={previewPhotos}
        />
      )}
      {openSequence && (
        <PhotoLightbox
          autoPlay={sequenceAutoPlay}
          initialIndex={0}
          onClose={({ photoId }) => {
            const sequenceId = openSequence.id;
            rememberPhoto(photoId, sequenceId);
            setOpenSequence(null);
            if (!(selectedSequence || detailPhoto)) {
              markRecentlyViewed(photoId, sequenceId);
            }
          }}
          onToggleFavorite={handleToggleFavorite}
          open={true}
          photos={openSequence.members}
          sequencePlayback={true}
          showThumbnailsInitially={true}
        />
      )}
      {quickPreviewIndex >= 0 && previewPhotos[quickPreviewIndex] && (
        <QuickPreview
          onClose={() => setQuickPreviewIndex(-1)}
          onNavigate={(dir) => {
            setQuickPreviewIndex((prev) => {
              const next = prev + dir;
              if (next < 0 || next >= previewPhotos.length) {
                return prev;
              }
              handleKeyboardSelect(previewPhotos[next].id);
              return next;
            });
          }}
          onOpenLightbox={() => {
            setLightboxIndex(quickPreviewIndex);
            setQuickPreviewIndex(-1);
          }}
          photo={previewPhotos[quickPreviewIndex]}
        />
      )}
      <PhotoContextMenu
        menu={ctxMenu}
        onAddToAlbum={handleAddToAlbum}
        onBatchAddToAlbum={() => {
          setAddToAlbumIds(Array.from(selectedIds));
          setAddToAlbumOpen(true);
          setCtxMenu((prev) => ({ ...prev, open: false }));
        }}
        onBatchDelete={handleDeleteSelected}
        onBatchExport={handleExportSelected}
        onBatchShare={handleShareSelected}
        onBatchToggleFavorite={handleBatchToggleFavorite}
        onBatchUploadToCloud={handleUploadSelectedToCloud}
        onClose={() => setCtxMenu((prev) => ({ ...prev, open: false }))}
        onDelete={handleDeletePhoto}
        onDeleteSequenceGroup={(ids) => {
          setPendingDeleteSequenceGroup(true);
          setPendingDeleteIds(ids);
          setDeleteConfirmOpen(true);
        }}
        onExport={handleExportPhoto}
        onOpenExplorer={handleOpenExplorer}
        onShare={handleShare}
        onToggleFavorite={handleToggleFavorite}
        onUploadToCloud={handleUploadToCloud}
      />
      <HomeActionDialogs
        album={{
          elevated: lightboxIndex >= 0,
          onClose: () => setAddToAlbumOpen(false),
          open: addToAlbumOpen,
          photoIds: addToAlbumIds,
        }}
        convert={{
          onClose: () => {
            setConvertDialogOpen(false);
          },
          onConvert: handleConvertSelected,
          open: convertDialogOpen,
          photoCount: selectedIds.size,
        }}
        cull={{
          defaultName: `${t("cullTitle")} · ${cullPhotoIds.length} ${t("photos")}`,
          onClose: () => setCullPhotoIds([]),
          onCreated: (sessionId) => {
            setCullPhotoIds([]);
            clearSelection();
            navigate({
              to: "/cull/$sessionId",
              params: { sessionId: String(sessionId) },
            });
          },
          open: cullPhotoIds.length >= 2,
          photoIds: cullPhotoIds,
        }}
        deletePhotos={{
          count: pendingDeleteIds.length,
          onCancel: () => {
            setDeleteConfirmOpen(false);
            setPendingDeleteIds([]);
            setPendingDeleteSequenceGroup(false);
          },
          onConfirm: executeDelete,
          open: deleteConfirmOpen,
          sequenceGroup: pendingDeleteSequenceGroup,
        }}
        exportPhotos={{
          onClose: () => setExportDialogOpen(false),
          open: exportDialogOpen,
          photoIds: exportIds,
        }}
        rename={{
          onClose: () => {
            setRenameDialogOpen(false);
          },
          onRename: handleRenameSelected,
          open: renameDialogOpen,
          photoCount: selectedIds.size,
          sampleFilename:
            photos.find((p) => selectedIds.has(p.id))?.filename ??
            photos[0]?.filename ??
            "photo.jpg",
          samplePhotoId:
            photos.find((p) => selectedIds.has(p.id))?.id ?? photos[0]?.id,
        }}
        share={{
          onClose: () => setShareDialogOpen(false),
          open: shareDialogOpen,
          photoIds: shareIds,
        }}
        upload={{
          onClose: () => setCloudUploadOpen(false),
          open: cloudUploadOpen,
          photoIds: cloudUploadIds,
        }}
      />
    </>
  );
}

export const Route = createFileRoute("/")({
  component: HomePage,
  validateSearch: (
    search: Record<string, unknown>
  ): {
    apertureMax?: string;
    apertureMin?: string;
    cameraModel?: string;
    creator?: string;
    lensModel?: string;
    advancedField?: string;
    advancedValue?: string;
    dashboardReturn?: string;
    dateFrom?: string;
    dateMonth?: string;
    dateHour?: string;
    dateTo?: string;
    favoriteOnly?: boolean;
    focalMax?: string;
    focalMin?: string;
    isoMax?: string;
    isoMin?: string;
    colorHex?: string;
    reset?: boolean;
    searchQuery?: string;
    shutterMax?: string;
    shutterMin?: string;
    tagId?: number;
  } => ({
    colorHex: search.colorHex as string | undefined,
    reset: search.reset === true || search.reset === "true" ? true : undefined,
    searchQuery: search.searchQuery as string | undefined,
    apertureMax: search.apertureMax as string | undefined,
    apertureMin: search.apertureMin as string | undefined,
    cameraModel: search.cameraModel as string | undefined,
    creator: search.creator as string | undefined,
    lensModel: search.lensModel as string | undefined,
    advancedField: search.advancedField as string | undefined,
    advancedValue: search.advancedValue as string | undefined,
    dashboardReturn:
      typeof search.dashboardReturn === "string"
        ? search.dashboardReturn
        : undefined,
    dateFrom: search.dateFrom as string | undefined,
    dateMonth: search.dateMonth as string | undefined,
    dateHour: search.dateHour as string | undefined,
    dateTo: search.dateTo as string | undefined,
    favoriteOnly:
      search.favoriteOnly === true || search.favoriteOnly === "true"
        ? true
        : undefined,
    focalMax: search.focalMax as string | undefined,
    focalMin: search.focalMin as string | undefined,
    isoMax: search.isoMax as string | undefined,
    isoMin: search.isoMin as string | undefined,
    shutterMax: search.shutterMax as string | undefined,
    shutterMin: search.shutterMin as string | undefined,
    tagId: search.tagId == null ? undefined : Number(search.tagId),
  }),
});
