import { createFileRoute, useNavigate } from "@tanstack/react-router";
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
import { AddToAlbumDialog } from "@/components/AddToAlbumDialog";
import { BatchRenameDialog } from "@/components/BatchRenameDialog";
import { CloudUploadDialog } from "@/components/CloudUploadDialog";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { ExportDialog } from "@/components/ExportDialog";
import { FormatConvertDialog } from "@/components/FormatConvertDialog";
import type { MasonryGridHandle } from "@/components/MasonryGrid";
import { clearImageLoadCache } from "@/components/PhotoCard";
import type { MenuState } from "@/components/PhotoContextMenu";
import { PhotoContextMenu } from "@/components/PhotoContextMenu";
import {
  loadPhotoDetailPanelWidth,
  PhotoDetailPanel,
} from "@/components/PhotoDetailPanel";
import {
  GRID_COLUMN_WIDTH_KEY,
  GRID_COLUMN_WIDTH_MAX,
  GRID_COLUMN_WIDTH_MIN,
  loadGridColumnWidth,
  PhotoGrid,
  type SortField,
  type SortOrder,
} from "@/components/PhotoGrid";
import { PhotoLightbox } from "@/components/PhotoLightbox";
import { QuickPreview } from "@/components/QuickPreview";
import { SearchBar } from "@/components/SearchBar";
import type { ExifFilters, SearchMode } from "@/types/search";
import { SearchEmptyState } from "@/components/SearchEmptyState";
import { SelectionActionBar } from "@/components/SelectionActionBar";
import { SortDropdown } from "@/components/SortDropdown";
import { CullStartDialog } from "@/components/CullStartDialog";
import { ShareDialog } from "@/components/ShareDialog";
import { StatusBar } from "@/components/StatusBar";
import { Welcome } from "@/components/Welcome";
import { useBrowseSession } from "@/contexts/BrowseSessionContext";
import { useScrollPosition } from "@/contexts/ScrollPositionContext";
import { useSidebarFilter } from "@/contexts/SidebarFilterContext";
import { useAiStatus } from "@/hooks/useAiStatus";
import { useGlobalDropZone } from "@/hooks/useGlobalDropZone";
import { useFolders } from "@/hooks/useFolders";
import { usePhotoDetailPanel } from "@/hooks/usePhotoDetailPanel";
import { usePhotoSelection } from "@/hooks/usePhotoSelection";
import { usePhotos } from "@/hooks/usePhotos";
import { useScrollRestorePreloader } from "@/hooks/useScrollRestorePreloader";
import { ipc } from "@/ipc/manager";
import { queryClient } from "@/providers/QueryProvider";
import type { Photo } from "@/types/photo";
import { recordGalleryPerf } from "@/utils/gallery-perf";
import {
  loadSortField,
  loadSortOrder,
  saveSortPreference,
} from "./home-sort-storage";

interface SemanticSearchMeta {
  indexedPhotos: number;
  reason?: string;
  state: "ready" | "partial" | "unavailable" | "error";
  totalPhotos: number;
  used: boolean;
}

const SEARCH_MODES: SearchMode[] = ["text", "image", "exif", "color"];

function isSearchMode(value: string | null): value is SearchMode {
  return SEARCH_MODES.includes(value as SearchMode);
}

function resolveSearchMode(query: string, color?: string | null): SearchMode {
  if (color) {
    return "color";
  }
  if (query.trim()) {
    return "text";
  }
  return "exif";
}

function HomePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const filter = useSidebarFilter();
  const { handleGlobalDragOver, handleGlobalDrop } = useGlobalDropZone();
  // 搜索状态：从 BrowseSessionContext 恢复，导航回来时保留搜索上下文
  const { getSession: getBrowseSession, saveSession: saveBrowseSession } =
    useBrowseSession();
  const searchQuery = filter.appliedSearch?.query ?? "";
  const searchMode = filter.appliedSearch?.mode ?? null;
  const [searchTime, setSearchTime] = useState<number | undefined>(undefined);
  const [searchResults, setSearchResults] = useState<Photo[] | null>(null);
  const [searchSemantic, setSearchSemantic] =
    useState<SemanticSearchMeta | null>(null);
  const pendingSemanticRefreshRef = useRef<{
    colorHex?: string;
    filters?: ExifFilters;
    generation: number;
    query: string;
  } | null>(null);
  const searchExpandedRef = useRef(false);
  const lastSearchParamsRef = useRef<{
    query: string;
    filters?: ExifFilters;
    colorHex?: string;
  } | null>(null);
  const colorHex = filter.appliedSearch?.colorHex ?? null;
  const [lightboxIndex, setLightboxIndex] = useState(-1);
  const [ctxMenu, setCtxMenu] = useState<MenuState>({
    open: false,
    x: 0,
    y: 0,
    photoId: null,
    photoPath: null,
    isBatch: false,
    selectionCount: 0,
  });
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [convertDialogOpen, setConvertDialogOpen] = useState(false);
  const [addToAlbumOpen, setAddToAlbumOpen] = useState(false);
  const [addToAlbumIds, setAddToAlbumIds] = useState<number[]>([]);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportIds, setExportIds] = useState<number[]>([]);
  const [cloudUploadOpen, setCloudUploadOpen] = useState(false);
  const [cloudUploadIds, setCloudUploadIds] = useState<number[]>([]);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [shareIds, setShareIds] = useState<number[]>([]);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [cullPhotoIds, setCullPhotoIds] = useState<number[]>([]);
  const [pendingDeleteIds, setPendingDeleteIds] = useState<number[]>([]);
  const [deletingIds, setDeletingIds] = useState<Set<number>>(new Set());
  const [searchLoading, setSearchLoading] = useState(false);
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
  const [showDrillBanner, setShowDrillBanner] = useState(false);
  const [drillDownFilters, setDrillDownFilters] = useState<ExifFilters>();
  const [showAiIndexHint, setShowAiIndexHint] = useState(false);
  const [searchResultFade, setSearchResultFade] = useState(false);
  const [parsedTimeFilter, setParsedTimeFilter] = useState<{
    dateFrom: string;
    dateTo: string;
    keyword: string;
  } | null>(null);

  // --- TanStack Query hooks ---
  const isSearching = searchMode !== null;

  // Drill-down from dashboard: detect search params and auto-trigger EXIF search
  const drillParams = Route.useSearch();
  const drillConsumed = useRef(false);
  const searchGenerationRef = useRef(0);

  const resetHomeSearchState = useCallback(() => {
    searchGenerationRef.current += 1;
    pendingSemanticRefreshRef.current = null;
    searchExpandedRef.current = false;
    lastSearchParamsRef.current = null;
    setSearchTime(undefined);
    setSearchResults(null);
    setSearchSemantic(null);
    setSearchLoading(false);
    setParsedTimeFilter(null);
    setShowAiIndexHint(false);
    setShowDrillBanner(false);
    setDrillDownFilters(undefined);
    setSearchResultFade(false);
    saveBrowseSession("home-search", {
      colorHex: null,
      searchMode: null,
      searchQuery: "",
    });
    navigate({ to: "/", search: {}, replace: true });
  }, [navigate, saveBrowseSession]);

  const handledSearchResetVersion = useRef(filter.searchResetVersion);
  useLayoutEffect(() => {
    if (handledSearchResetVersion.current === filter.searchResetVersion) {
      return;
    }
    handledSearchResetVersion.current = filter.searchResetVersion;
    resetHomeSearchState();
  }, [filter.searchResetVersion, resetHomeSearchState]);

  useEffect(() => {
    const hasParams = Object.values(drillParams).some((v) => v !== undefined);

    if (!hasParams) {
      drillConsumed.current = false;
      setShowDrillBanner(false);
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
      navigate({ to: "/", search: {}, replace: true });
      setSearchTime(undefined);
      setSearchResults(null);
      filter.setFavoriteOnly(true); // also clears activeFolderId + activeTagIds
      return;
    }

    setShowDrillBanner(true);

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
    handleSearch(textQuery, filters, colorHexParam);
  }, [drillParams, navigate]); // eslint-disable-line react-hooks/exhaustive-deps

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
  }, []);

  // Listen for file-change events from main process (chokidar watcher)
  useEffect(() => {
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
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [t]);

  const {
    data: photosData,
    fetchNextPage,
    hasNextPage,
    isLoading: photosLoading,
    isFetchingNextPage,
    isPlaceholderData: photosIsPlaceholder,
  } = usePhotos({
    folderId: filter.activeFolderId,
    tagIds: filter.activeTagIds.length > 0 ? filter.activeTagIds : undefined,
    tagMode: filter.tagMode,
    favoriteOnly: filter.favoriteOnly || undefined,
    sort: sortField,
    order: sortOrder,
    enabled: !isSearching,
  });
  const { data: folders = [] } = useFolders();

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
    void handleSearch(pending.query, pending.filters, pending.colorHex);
  }, [aiStatus?.coverageState, searchMode, searchQuery]);

  // Flatten paginated photos
  const pagedPhotos = useMemo(
    () => photosData?.pages.flatMap((p) => p.items) ?? [],
    [photosData]
  );
  const totalFromQuery = photosData?.pages[0]?.total ?? 0;

  useEffect(() => {
    recordGalleryPerf("galleryPagedPhotoCount", pagedPhotos.length);
    recordGalleryPerf("galleryLoadedPageCount", photosData?.pages.length ?? 0);
  }, [pagedPhotos.length, photosData?.pages.length]);

  const THUMBNAIL_BACKFILL_BATCH_SIZE = 4;
  const THUMBNAIL_BACKFILL_DELAY_MS = 6000;
  const THUMBNAIL_BACKFILL_IDLE_TIMEOUT_MS = 4000;
  const thumbnailBackfillQueuedRef = useRef<Set<number>>(new Set());

  // Active photo list: search results or paginated query.
  // `rawPhotos` is the real-time array; `photos` is deferred to avoid
  // blocking the main thread when switching between 20K+ item lists.
  const rawPhotos = isSearching ? (searchResults ?? []) : pagedPhotos;
  const photos = useDeferredValue(rawPhotos);
  // Only show stale overlay when the data *source* changes (search↔browse),
  // not during pagination or in-place refreshes.
  const prevIsSearching = useRef(isSearching);
  const isPhotosStale =
    rawPhotos !== photos && prevIsSearching.current !== isSearching;
  prevIsSearching.current = isSearching;
  const photosRef = useRef(rawPhotos);
  photosRef.current = rawPhotos;

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
          queryClient.setQueriesData({ queryKey: ["photos"] }, (data: any) => {
            if (!data?.pages) {
              return data;
            }
            let changed = false;
            const pages = data.pages.map((page: any) => ({
              ...page,
              items: page.items.map((photo: Photo) => {
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
          });
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
  }, [rawPhotos]);

  // 持久化搜索状态 + 挂载时自动重新搜索
  const searchStateRef = useRef({ searchQuery, searchMode, colorHex });
  searchStateRef.current = { searchQuery, searchMode, colorHex };
  useEffect(() => {
    return () => {
      saveBrowseSession("home-search", {
        searchQuery: searchStateRef.current.searchQuery,
        searchMode: searchStateRef.current.searchMode,
        colorHex: searchStateRef.current.colorHex,
      });
    };
  }, [saveBrowseSession]);

  // 挂载时如果有保存的搜索，等 AI 模型就绪后自动重新搜索
  const aiStatusRef = useRef(aiStatus);
  aiStatusRef.current = aiStatus;
  const restoredSearchRef = useRef(false);
  useEffect(() => {
    if (restoredSearchRef.current) {
      return;
    }
    // 如果 URL 已有钻取参数（如从仪表盘色块点击），跳过恢复：
    // 钻取参数优先于 sessionStorage，否则旧颜色会 setTimeout 覆盖新钻取结果。
    const hasDrillParams = Object.values(drillParams).some(
      (v) => v !== undefined
    );
    if (hasDrillParams) {
      return;
    }
    const saved = getBrowseSession("home-search");
    if (saved.searchQuery || saved.searchMode === "color" || saved.colorHex) {
      restoredSearchRef.current = true;
      const q = saved.searchQuery;
      const restoredMode = isSearchMode(saved.searchMode)
        ? saved.searchMode
        : resolveSearchMode(q, saved.colorHex);
      filter.applySearch({
        colorHex: saved.colorHex ?? undefined,
        filters: {},
        mode: restoredMode,
        query: q,
      });
      // 等 AI 模型就绪后自动触发搜索（轮询检测，最多等 10s）
      let attempts = 0;
      const trySearch = () => {
        attempts++;
        if (aiStatusRef.current?.hasVectors !== undefined || attempts > 100) {
          handleSearch(q, undefined, saved.colorHex ?? undefined);
        } else {
          setTimeout(trySearch, 100);
        }
      };
      setTimeout(trySearch, 300);
    }
  }, []); // 仅首次挂载

  // 动态 routeKey：区分搜索/筛选/排序状态
  // ⚠️ 所有 filter 字段必须做 ?? fallback，防止卸载期 SidebarFilterContext
  // 重置导致 "undefined" 字符串窜入 Key（如 home-all-undefined vs home-all）
  const { markRouteDirty } = useScrollPosition();
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
    const searchPart = isSearching ? `search-${searchMode}-${searchQuery}` : "";
    return `home-${filterPart}${searchPart}`;
  }, [
    isSearching,
    searchMode,
    searchQuery,
    filter.activeFolderId,
    filter.activeTagIds,
    filter.favoriteOnly,
    sortField,
    sortOrder,
  ]);

  // ── 网格 ref（用于原子化滚动定位）─────────────────────────────
  const gridRef = useRef<MasonryGridHandle>(null);

  // ── 原子化预加载：数据未就位时不渲染 MasonryGrid ──────────────
  const { preloadState } = useScrollRestorePreloader({
    routeKey,
    pageSize: 100,
    currentItemCount: pagedPhotos.length,
    hasMore: hasNextPage ?? false,
    isFetchingNextPage,
    onTimeout: () => {
      toast.info(t("scrollPositionReset", "视图位置已重置"), {
        duration: 2500,
      });
    },
  });

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

  // 共享 Hooks：选中状态、详情面板
  const {
    selectedIds,
    lastClickedIdx,
    handleSelect,
    handleKeyboardSelect,
    handleMarqueeSelect,
    clearSelection,
    removeFromSelection,
    selectAll: selectAllPhotos,
  } = usePhotoSelection(routeKey, photos);
  const { detailPhoto, detailDismissed, dismissDetail, navigateDetail } =
    usePhotoDetailPanel(selectedIds, photos, routeKey, handleKeyboardSelect);
  const totalPhotos = isSearching ? photos.length : totalFromQuery;
  const loading = isSearching ? searchLoading : photosLoading;
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
    setGalleryScrolled((previous) => {
      const next = scrollTop > 4;
      return previous === next ? previous : next;
    });
  }, []);

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
  const emptyStateContent = useMemo(() => {
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
          onGoToAiSettings={() => navigate({ to: "/settings" })}
          parsedTimeFilter={parsedTimeFilter}
          query={searchQuery}
          searchMode={searchMode}
          semanticState={searchSemantic?.state}
          totalPhotos={searchSemantic?.totalPhotos ?? 0}
        />
      );
    }
    if (filter.favoriteOnly) {
      return (
        <div className="flex flex-col items-center gap-3 text-center">
          <svg
            className="h-10 w-10 text-muted-foreground/40"
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
          <p className="font-medium text-[14px] text-foreground">
            {t("emptyFavoritesTitle")}
          </p>
          <p className="max-w-[280px] text-[12px] text-muted-foreground/70">
            {t("emptyFavoritesDescription")}
          </p>
        </div>
      );
    }
    return undefined;
  }, [
    isSearching,
    filter.favoriteOnly,
    t,
    searchMode,
    searchQuery,
    parsedTimeFilter,
    hasActiveExifFilters,
    aiStatus?.hasVectors,
    searchSemantic?.indexedPhotos,
    searchSemantic?.state,
    searchSemantic?.totalPhotos,
    navigate,
  ]);

  const handleEndReached = useCallback(() => {
    if (!isSearching && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    } else if (
      isSearching &&
      searchResults &&
      searchResults.length >= 200 &&
      !searchExpandedRef.current
    ) {
      // 搜索模式下：首次返回 200 条后，滚动到底自动加载更多
      // 直接调 IPC 追加结果，不触发 loading 状态避免闪烁
      const p = lastSearchParamsRef.current;
      if (!p) return;
      searchExpandedRef.current = true;
      const generation = searchGenerationRef.current;

      const startTime = performance.now();
      const searchParams: any = { limit: 1000 };
      if (p.query.trim()) searchParams.query = p.query.trim();
      if (p.colorHex) searchParams.colorHex = p.colorHex;
      if (p.filters?.dateFrom) {
        const [y, m, d] = p.filters.dateFrom.split("-").map(Number);
        searchParams.dateFrom = new Date(y, m - 1, d, 0, 0, 0).getTime();
      }
      if (p.filters?.dateMonth) {
        searchParams.dateMonth = Number(p.filters.dateMonth);
      }
      if (p.filters?.dateHour) {
        searchParams.dateHour = Number(p.filters.dateHour);
      }
      if (p.filters?.dateTo) {
        const [y, m, d] = p.filters.dateTo.split("-").map(Number);
        searchParams.dateTo = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
      }
      if (p.filters?.cameraModel)
        searchParams.cameraModel = p.filters.cameraModel;
      if (p.filters?.creator) searchParams.creator = p.filters.creator;
      if (p.filters?.lensModel) searchParams.lensModel = p.filters.lensModel;
      if (p.filters?.advancedField)
        searchParams.advancedField = p.filters.advancedField;
      if (p.filters?.advancedValue)
        searchParams.advancedValue = p.filters.advancedValue;
      if (p.filters?.focalMin)
        searchParams.focalMin = Number(p.filters.focalMin);
      if (p.filters?.focalMax)
        searchParams.focalMax = Number(p.filters.focalMax);
      if (p.filters?.apertureMin)
        searchParams.apertureMin = Number(p.filters.apertureMin);
      if (p.filters?.apertureMax)
        searchParams.apertureMax = Number(p.filters.apertureMax);
      if (p.filters?.isoMin) searchParams.isoMin = Number(p.filters.isoMin);
      if (p.filters?.isoMax) searchParams.isoMax = Number(p.filters.isoMax);
      if (p.filters?.shutterMin)
        searchParams.shutterMin = Number(p.filters.shutterMin);
      if (p.filters?.shutterMax)
        searchParams.shutterMax = Number(p.filters.shutterMax);

      ipc.client.photos
        .searchCompound(searchParams)
        .then((result: any) => {
          if (generation !== searchGenerationRef.current) {
            return;
          }
          const newResults = result.results || [];
          if (newResults.length > 0) {
            setSearchResults(newResults);
            setSearchTime(Math.round(performance.now() - startTime));
          }
        })
        .catch(() => {
          /* ignore */
        });
    }
  }, [
    isSearching,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    searchResults,
  ]);

  const handleToggleFavorite = useCallback(async (
    id: number,
    requestedValue?: boolean
  ) => {
    const photo = photosRef.current.find((p) => p.id === id);
    if (!photo) {
      return;
    }
    const prevVal = !!photo.isFavorite;
    const newVal = requestedValue ?? !prevVal;
    await ipc.client.photos.toggleFavorite({ ids: [id], favorite: newVal });
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
            queryClient.invalidateQueries({
              queryKey: ["photos"],
              refetchType: "active",
            });
          },
        },
      }
    );
  }, []);

  const handleDoubleClick = useCallback((id: number) => {
    const idx = photosRef.current.findIndex((p) => p.id === id);
    if (idx >= 0) {
      setLightboxIndex(idx);
    }
  }, []);
  async function handleSearch(
    query: string,
    filters?: ExifFilters,
    paramColorHex?: string
  ) {
    // paramColorHex 未传时沿用当前 state（保留钻取来的色彩筛选）
    const effectiveColorHex =
      paramColorHex === undefined ? colorHex : paramColorHex;
    const hasFilters = filters && Object.values(filters).some((v) => v);
    const hasColorHex = !!effectiveColorHex;

    if (!(query.trim() || hasFilters || hasColorHex)) {
      filter.clearSearch();
      pendingSemanticRefreshRef.current = null;
      setSearchSemantic(null);
      setSearchTime(undefined);
      setSearchResults(null);
      return;
    }

    // 递增代数，使前一个未完成的请求变成 stale
    const gen = ++searchGenerationRef.current;
    const startTime = performance.now();
    const nextSearchMode = resolveSearchMode(query, effectiveColorHex);
    filter.applySearch({
      colorHex: effectiveColorHex ?? undefined,
      filters: filters ?? {},
      mode: nextSearchMode,
      query,
    });
    setSearchLoading(true);

    try {
      const searchParams: {
        query?: string;
        colorHex?: string;
        dateFrom?: number;
        dateMonth?: number;
        dateHour?: number;
        dateTo?: number;
        cameraModel?: string;
        creator?: string;
        lensModel?: string;
        advancedField?: ExifFilters["advancedField"];
        advancedValue?: string;
        focalMin?: number;
        focalMax?: number;
        apertureMin?: number;
        apertureMax?: number;
        isoMin?: number;
        isoMax?: number;
        shutterMin?: number;
        shutterMax?: number;
        limit: number;
      } = { limit: searchExpandedRef.current ? 1000 : 200 };
      if (query.trim()) {
        searchParams.query = query.trim();
      }
      if (effectiveColorHex) {
        searchParams.colorHex = effectiveColorHex;
      }
      if (filters?.dateFrom) {
        const [y, m, d] = filters.dateFrom.split("-").map(Number);
        searchParams.dateFrom = new Date(y, m - 1, d, 0, 0, 0).getTime();
      }
      if (filters?.dateMonth) {
        searchParams.dateMonth = Number(filters.dateMonth);
      }
      if (filters?.dateHour) {
        searchParams.dateHour = Number(filters.dateHour);
      }
      if (filters?.dateTo) {
        const [y, m, d] = filters.dateTo.split("-").map(Number);
        searchParams.dateTo = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
      }
      if (filters?.cameraModel) {
        searchParams.cameraModel = filters.cameraModel;
      }
      if (filters?.creator) {
        searchParams.creator = filters.creator;
      }
      if (filters?.lensModel) {
        searchParams.lensModel = filters.lensModel;
      }
      if (filters?.advancedField) {
        searchParams.advancedField = filters.advancedField;
      }
      if (filters?.advancedValue) {
        searchParams.advancedValue = filters.advancedValue;
      }
      if (filters?.focalMin) {
        searchParams.focalMin = Number(filters.focalMin);
      }
      if (filters?.focalMax) {
        searchParams.focalMax = Number(filters.focalMax);
      }
      if (filters?.apertureMin) {
        searchParams.apertureMin = Number(filters.apertureMin);
      }
      if (filters?.apertureMax) {
        searchParams.apertureMax = Number(filters.apertureMax);
      }
      if (filters?.isoMin) {
        searchParams.isoMin = Number(filters.isoMin);
      }
      if (filters?.isoMax) {
        searchParams.isoMax = Number(filters.isoMax);
      }
      if (filters?.shutterMin) {
        searchParams.shutterMin = Number(filters.shutterMin);
      }
      if (filters?.shutterMax) {
        searchParams.shutterMax = Number(filters.shutterMax);
      }

      // 保存搜索参数以支持"加载更多"
      if (!searchExpandedRef.current) {
        lastSearchParamsRef.current = {
          query,
          filters,
          colorHex: effectiveColorHex ?? undefined,
        };
      }

      const result = (await ipc.client.photos.searchCompound(
        searchParams
      )) as any;

      // 竞态保护：如果代数不匹配，说明已有更新的搜索启动，丢弃此过时响应
      if (gen !== searchGenerationRef.current) {
        return;
      }

      const results = result.results || [];
      const semantic = (result.semantic ?? null) as SemanticSearchMeta | null;
      setSearchSemantic(semantic);
      if (
        semantic &&
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

      if (result.timeFilter) {
        const tf = result.timeFilter as { dateFrom: string; dateTo: string };
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
        const matched = TIME_KEYWORDS.find((kw) => query.includes(kw));
        setParsedTimeFilter({
          dateFrom: tf.dateFrom,
          dateTo: tf.dateTo,
          keyword: matched || "",
        });
      } else {
        setParsedTimeFilter(null);
      }

      if (
        results.length === 0 &&
        aiStatus &&
        !aiStatus.hasVectors &&
        query.trim()
      ) {
        setShowAiIndexHint(true);
      } else {
        setShowAiIndexHint(false);
      }

      setSearchResults(results);
      setSearchTime(Math.round(performance.now() - startTime));
      setSearchResultFade(true);
    } catch {
      if (gen !== searchGenerationRef.current) {
        return;
      }
      // 颜色搜索失败不降级到全量查询
      if (effectiveColorHex) {
        setSearchResults([]);
        setSearchTime(Math.round(performance.now() - startTime));
      } else {
        try {
          const fallback = await ipc.client.photos.listPhotos({
            search: query.trim() || undefined,
            sort: "date",
            order: "desc",
            offset: 0,
            limit: 500,
          });
          if (gen !== searchGenerationRef.current) {
            return;
          }
          setSearchResults((fallback as any).items || []);
          setSearchTime(Math.round(performance.now() - startTime));
        } catch {
          if (gen !== searchGenerationRef.current) {
            return;
          }
          toast.error(t("toastSearchFailed"));
          setSearchResults([]);
        }
      }
    } finally {
      if (gen === searchGenerationRef.current) {
        setSearchLoading(false);
      }
    }
  }
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
      if (!id) {
        return;
      }
      e.preventDefault();
      const inSelection = selectedIds.has(id);
      const isBatch = selectedIds.size > 1 && inSelection;
      setCtxMenu({
        open: true,
        x: e.clientX,
        y: e.clientY,
        photoId: id,
        photoPath: path,
        isBatch,
        selectionCount: isBatch ? selectedIds.size : 1,
      });
    },
    [selectedIds]
  );

  async function handleOpenExplorer(filePath: string) {
    await ipc.client.shell.openInExplorer({ path: filePath });
  }

  function handleDeletePhoto(id: number) {
    setPendingDeleteIds([id]);
    setDeleteConfirmOpen(true);
  }

  function handleAddToAlbum(id: number) {
    setAddToAlbumIds([id]);
    setAddToAlbumOpen(true);
  }

  async function handleExportPhoto(id: number) {
    setExportIds([id]);
    setExportDialogOpen(true);
  }

  async function handleExportSelected() {
    setExportIds(Array.from(selectedIds));
    setExportDialogOpen(true);
  }

  function handleUploadToCloud(id: number) {
    setCloudUploadIds([id]);
    setCloudUploadOpen(true);
  }

  function handleUploadSelectedToCloud() {
    setCloudUploadIds(Array.from(selectedIds));
    setCloudUploadOpen(true);
  }

  function handleShare(id: number) {
    setShareIds([id]);
    setShareDialogOpen(true);
  }

  function handleShareSelected() {
    setShareIds(Array.from(selectedIds));
    setShareDialogOpen(true);
  }

  function handleDeleteSelected() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) {
      return;
    }
    setPendingDeleteIds(ids);
    setDeleteConfirmOpen(true);
  }

  async function executeDelete() {
    const ids = pendingDeleteIds;
    const count = ids.length;
    setDeleteConfirmOpen(false);
    setPendingDeleteIds([]);
    // Trigger exit animation
    setDeletingIds(new Set(ids));
    await new Promise((r) => setTimeout(r, 180));
    setDeletingIds(new Set());
    try {
      if (ids.length === 1) {
        await ipc.client.photos.deletePhoto({ id: ids[0] });
      } else {
        await ipc.client.photos.deletePhotos({ ids });
      }
      // 标记滚动位置为脏：已删除照片的锚点已失效
      markRouteDirty(routeKey);
      // 从选中集合中移除已删除的照片
      removeFromSelection(ids);
      if (isSearching) {
        setSearchResults(
          (prev) => prev?.filter((p) => !ids.includes(p.id)) ?? null
        );
      } else {
        queryClient.invalidateQueries({
          queryKey: ["photos"],
          refetchType: "active",
        });
      }
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      toast.success(t("toastDeletedCount", { count }));
    } catch {
      toast.error(t("toastDeleteFailed"));
    }
  }

  async function handleRenameSelected(pattern: string) {
    const ids = Array.from(selectedIds);
    try {
      const result = await ipc.client.photos.renamePhotos({ ids, pattern });
      queryClient.invalidateQueries({
        queryKey: ["photos"],
        refetchType: "active",
      });
      const r = result as {
        renamed: number;
        errors: number;
        results: Array<{
          id: number;
          oldName: string;
          newName: string;
          error?: string;
        }>;
      };
      toast.success(
        r.errors > 0
          ? t("toastRenamePartial", { count: r.renamed, errors: r.errors })
          : t("toastRenameCount", { count: r.renamed })
      );
      return r;
    } catch {
      toast.error(t("toastRenameFailed"));
      return { renamed: 0, errors: ids.length, results: [] };
    }
  }

  async function handleConvertSelected(options: {
    format: "jpg" | "png" | "webp" | "avif";
    quality: number;
    maxWidth: number;
    outputDir: string;
  }) {
    const ids = Array.from(selectedIds);
    try {
      const result = await ipc.client.photos.convertPhotos({
        ids,
        format: options.format,
        quality: options.quality,
        maxWidth: options.maxWidth || undefined,
        outputDir: options.outputDir,
      });
      const r = result as { converted: number; outputDir: string };
      toast.success(t("toastConvertedCount", { count: r.converted }));
      return r;
    } catch {
      toast.error(t("toastConvertFailed"));
      return { converted: 0, outputDir: options.outputDir };
    }
  }

  async function handleImageSearch(imagePath: string) {
    const gen = ++searchGenerationRef.current;
    const imageSearchQuery = t("imageSearchToken");
    filter.applySearch({ filters: {}, mode: "image", query: imageSearchQuery });
    setSearchLoading(true);
    const startTime = performance.now();
    try {
      const result = await ipc.client.photos.searchByImage({
        imagePath,
        limit: 500,
      });
      // 竞态保护：丢弃过时响应
      if (gen !== searchGenerationRef.current) {
        return;
      }
      if (result.error) {
        console.warn("[ImageSearch]", result.error);
      }
      const results = (result as any).results || [];
      setSearchResults(results);
      setSearchTime(Math.round(performance.now() - startTime));
    } catch (err: any) {
      if (gen !== searchGenerationRef.current) {
        return;
      }
      console.error("[ImageSearch] failed:", err?.message || err);
      toast.error(t("toastImageSearchFailed"));
      setSearchResults([]);
      setSearchTime(Math.round(performance.now() - startTime));
    } finally {
      if (gen === searchGenerationRef.current) {
        setSearchLoading(false);
      }
    }
  }

  // Keyboard shortcuts for batch operations
  // biome-ignore lint/correctness/useExhaustiveDependencies: handler functions are intentionally excluded
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        selectAllPhotos();
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
        if (selectedIds.size > 0) {
          clearSelection();
          return;
        }
      }

      if (e.key === " " && selectedIds.size > 0 && quickPreviewIndex < 0) {
        e.preventDefault();
        const firstId = selectedIds.values().next().value as number;
        const idx = photos.findIndex((p) => p.id === firstId);
        if (idx >= 0) {
          setQuickPreviewIndex(idx);
        }
        return;
      }

      if (e.key === "f" && selectedIds.size > 0 && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const ids = [...selectedIds];
        const allFav = ids.every(
          (id) => photos.find((p) => p.id === id)?.isFavorite
        );
        const newVal = !allFav;
        ipc.client.photos.toggleFavorite({ ids, favorite: newVal }).then(() => {
          queryClient.invalidateQueries({
            queryKey: ["photos"],
            refetchType: "active",
          });
          toast.success(
            newVal
              ? t("toastFavoriteAddedCount", { count: ids.length })
              : t("toastFavoriteRemoved"),
            {
              action: {
                label: t("toastUndo"),
                onClick: async () => {
                  await ipc.client.photos.toggleFavorite({
                    ids,
                    favorite: allFav,
                  });
                  queryClient.invalidateQueries({
                    queryKey: ["photos"],
                    refetchType: "active",
                  });
                },
              },
            }
          );
        });
        return;
      }

      if (e.key === "i" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (detailPhoto) {
          dismissDetail();
          clearSelection();
        } else if (selectedIds.size === 1) {
          const id = selectedIds.values().next().value as number;
          handleKeyboardSelect(id);
        }
        return;
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    photos,
    selectedIds,
    renameDialogOpen,
    convertDialogOpen,
    quickPreviewIndex,
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

  const hasPhotos =
    photos.length > 0 ||
    (loading && photos.length === 0) ||
    isSearching ||
    filter.favoriteOnly;

  return (
    <>
      <div
        className="relative flex h-full min-w-0 flex-col"
        onDragOver={handleGlobalDragOver}
        onDrop={handleGlobalDrop}
      >
        <div
          className={`home-gallery-toolbar-layer ${galleryScrolled ? "is-scrolled" : ""}`}
          ref={galleryToolbarRef}
          style={{ right: detailPhoto ? detailPanelWidth : 0 }}
        >
          <SearchBar
            aiStatus={aiStatus ?? null}
            colorHex={colorHex ?? undefined}
            drillDownFilters={drillDownFilters}
            filters={filter.searchDraft.filters}
            imageSearchActive={searchMode === "image"}
            leadingContent={
              <div className="flex min-w-[148px] max-w-[220px] items-center gap-2 pr-1">
                <div className="min-w-0">
                  <div className="truncate font-medium text-[13px] text-foreground">
                    {galleryContextLabel}
                  </div>
                  <div className="text-[10px] text-muted-foreground/70 tabular-nums">
                    {t("photosCount", { count: totalPhotos.toLocaleString() })}
                  </div>
                </div>
              </div>
            }
            onClear={filter.clearSearch}
            onFiltersChange={filter.setSearchDraftFilters}
            onImageSearch={handleImageSearch}
            onQueryChange={filter.setSearchDraftQuery}
            onSearch={handleSearch}
            query={filter.searchDraft.query}
            resetVersion={filter.searchResetVersion}
            resultCount={searchQuery ? photos.length : undefined}
            searchMode={searchMode}
            searchTime={searchTime}
            trailingContent={
              <>
                <SortDropdown
                  onChange={handleSortChange}
                  order={sortOrder}
                  sort={sortField}
                />
                <label className="home-grid-size-control flex items-center gap-1.5 text-[10px] text-muted-foreground/70">
                  <span>{t("gridSize")}</span>
                  <input
                    aria-label={t("gridSize")}
                    className="h-4 w-16 cursor-pointer accent-primary"
                    max={GRID_COLUMN_WIDTH_MAX}
                    min={GRID_COLUMN_WIDTH_MIN}
                    onChange={(event) =>
                      handleGridColumnWidthChange(Number(event.target.value))
                    }
                    step={10}
                    type="range"
                    value={gridColumnWidth}
                  />
                </label>
              </>
            }
          />
          {searchMode === "text" &&
            searchSemantic &&
            searchSemantic.state !== "ready" && (
              <div className="border-amber-300 border-b bg-amber-50 px-4 py-2 text-amber-900 text-xs dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                {searchSemantic.state === "error"
                  ? t("semanticSearchUnavailable")
                  : t("semanticSearchPartial", {
                      indexed: searchSemantic.indexedPhotos,
                      total: searchSemantic.totalPhotos,
                    })}
              </div>
            )}
          {/* Drill-down banner */}
          {showDrillBanner && (
            <div className="flex items-center justify-between border-blue-200 border-b bg-blue-50 px-4 py-2 dark:border-blue-800 dark:bg-blue-900/20">
              <div className="flex items-center gap-2">
                <span className="text-blue-900 text-sm dark:text-blue-100">
                  {t("drillDownActiveHint")}
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  className="rounded-[4px] px-2 py-1 text-[11px] text-blue-700 hover:bg-blue-100 dark:text-blue-300 dark:hover:bg-blue-800"
                  onClick={() => {
                    filter.setSearchDraftFilters({});
                    filter.clearSearch();
                    setDrillDownFilters(undefined);
                    setShowDrillBanner(false);
                  }}
                  type="button"
                >
                  {t("clearAll")}
                </button>
                <button
                  className="rounded-[4px] border border-blue-300 px-2 py-1 text-[11px] text-blue-700 hover:bg-blue-100 dark:border-blue-700 dark:text-blue-300 dark:hover:bg-blue-800"
                  onClick={() => navigate({ to: "/dashboard" })}
                  type="button"
                >
                  {t("backToDashboard")}
                </button>
              </div>
            </div>
          )}
        </div>
        {hasPhotos ? (
          <div className="home-gallery-body relative flex min-h-0 flex-1">
            <div
              className={`relative flex min-w-0 flex-1 ${
                searchResultFade ? "search-results-enter" : ""
              }`}
              onAnimationEnd={() => setSearchResultFade(false)}
            >
              {/* 预加载进度条：顶部极细扫描线，不遮挡底层 UI */}
              {preloadState === "preloading" && (
                <div className="absolute top-0 right-0 left-0 z-30 h-[2px] overflow-hidden bg-transparent">
                  <div
                    className="h-full rounded-full bg-primary/70"
                    style={{
                      width: "35%",
                      animation: "indeterminate 1.4s ease-in-out infinite",
                    }}
                  />
                </div>
              )}
              <PhotoGrid
                columnWidth={gridColumnWidth}
                deletingIds={deletingIds}
                emptyState={emptyStateContent}
                gridRef={gridRef}
                hasMore={hasNextPage}
                isLoadingMore={isFetchingNextPage}
                isPlaceholderData={photosIsPlaceholder}
                loading={loading}
                onBackgroundClick={() => {
                  if (marqueeJustCompleted.current) {
                    marqueeJustCompleted.current = false;
                    return;
                  }
                  clearSelection();
                }}
                onContextMenu={handleContextMenu}
                onDoubleClick={handleDoubleClick}
                onEndReached={handleEndReached}
                onKeyboardSelect={handleKeyboardSelect}
                onMarqueeSelect={wrappedMarqueeSelect}
                onScrollTopChange={handleGalleryScrollTopChange}
                onSelect={handleSelect}
                onToggleFavorite={handleToggleFavorite}
                photos={photos}
                isStale={isPhotosStale}
                routeKey={routeKey}
                searchQuery={searchQuery}
                selectedIds={selectedIds}
                showToolbar={false}
                sort={sortField}
                sortOrder={sortOrder}
                topInset={galleryToolbarHeight}
              />
              <SelectionActionBar
                allFavorite={
                  selectedIds.size > 0 &&
                  [...selectedIds].every(
                    (id) => photos.find((p) => p.id === id)?.isFavorite
                  )
                }
                onAddToAlbum={() => {
                  setAddToAlbumIds(Array.from(selectedIds));
                  setAddToAlbumOpen(true);
                }}
                onClearSelection={clearSelection}
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
                onToggleFavorite={() => {
                  const ids = [...selectedIds];
                  const allFav = ids.every(
                    (id) => photos.find((p) => p.id === id)?.isFavorite
                  );
                  const newVal = !allFav;
                  ipc.client.photos
                    .toggleFavorite({ ids, favorite: newVal })
                    .then(() => {
                      queryClient.invalidateQueries({
                        queryKey: ["photos"],
                        refetchType: "active",
                      });
                      toast.success(
                        newVal
                          ? t("toastFavoriteAddedCount", { count: ids.length })
                          : t("toastFavoriteRemoved"),
                        {
                          action: {
                            label: t("toastUndo"),
                            onClick: async () => {
                              await ipc.client.photos.toggleFavorite({
                                ids,
                                favorite: allFav,
                              });
                              queryClient.invalidateQueries({
                                queryKey: ["photos"],
                              });
                            },
                          },
                        }
                      );
                    });
                }}
                onUploadToCloud={handleUploadSelectedToCloud}
                selectedCount={selectedIds.size}
                bottomOffset={showAiTaskStatus ? 44 : 16}
              />
            </div>
            <PhotoDetailPanel
              onClose={() => {
                dismissDetail();
                clearSelection();
              }}
              onNavigate={navigateDetail}
              onOpenExplorer={handleOpenExplorer}
              onWidthChange={setDetailPanelWidth}
              photo={detailPhoto}
            />
          </div>
        ) : (
          <div
            className="flex min-h-0 flex-1"
            style={{ paddingTop: galleryToolbarHeight }}
          >
            <Welcome disabled={false} onAddFolder={filter.handleAddFolder} />
          </div>
        )}
        {showAiTaskStatus && (
          <StatusBar
            aiStatus={aiStatus ?? null}
            className="absolute right-0 bottom-0 left-0 z-50"
            selectedCount={selectedIds.size}
            totalPhotos={totalPhotos}
          />
        )}
      </div>
      {lightboxIndex >= 0 && (
        <PhotoLightbox
          initialIndex={lightboxIndex}
          modalOpen={addToAlbumOpen}
          onAddToAlbum={handleAddToAlbum}
          onClose={({ photoId }) => {
            setLightboxIndex(-1);
            handleKeyboardSelect(photoId);
          }}
          onToggleFavorite={handleToggleFavorite}
          open={lightboxIndex >= 0}
          photos={photos}
        />
      )}
      {quickPreviewIndex >= 0 && photos[quickPreviewIndex] && (
        <QuickPreview
          onClose={() => setQuickPreviewIndex(-1)}
          onNavigate={(dir) => {
            setQuickPreviewIndex((prev) => {
              const next = prev + dir;
              if (next < 0 || next >= photos.length) {
                return prev;
              }
              handleKeyboardSelect(photos[next].id);
              return next;
            });
          }}
          onOpenLightbox={() => {
            setLightboxIndex(quickPreviewIndex);
            setQuickPreviewIndex(-1);
          }}
          photo={photos[quickPreviewIndex]}
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
        onBatchToggleFavorite={() => {
          const ids = [...selectedIds];
          const allFav = ids.every(
            (id) => photos.find((p) => p.id === id)?.isFavorite
          );
          const newVal = !allFav;
          ipc.client.photos
            .toggleFavorite({ ids, favorite: newVal })
            .then(() => {
              queryClient.invalidateQueries({
                queryKey: ["photos"],
                refetchType: "active",
              });
              toast.success(
                newVal
                  ? t("toastFavoriteAddedCount", { count: ids.length })
                  : t("toastFavoriteRemoved"),
                {
                  action: {
                    label: t("toastUndo"),
                    onClick: async () => {
                      await ipc.client.photos.toggleFavorite({
                        ids,
                        favorite: allFav,
                      });
                      queryClient.invalidateQueries({
                        queryKey: ["photos"],
                        refetchType: "active",
                      });
                    },
                  },
                }
              );
            });
        }}
        onBatchUploadToCloud={handleUploadSelectedToCloud}
        onClose={() => setCtxMenu((prev) => ({ ...prev, open: false }))}
        onDelete={handleDeletePhoto}
        onExport={handleExportPhoto}
        onOpenExplorer={handleOpenExplorer}
        onShare={handleShare}
        onToggleFavorite={handleToggleFavorite}
        onUploadToCloud={handleUploadToCloud}
      />
      <BatchRenameDialog
        onClose={() => {
          setRenameDialogOpen(false);
          clearSelection();
        }}
        onRename={handleRenameSelected}
        open={renameDialogOpen}
        photoCount={selectedIds.size}
        sampleFilename={
          photos.find((p) => selectedIds.has(p.id))?.filename ??
          photos[0]?.filename ??
          "photo.jpg"
        }
        samplePhotoId={
          photos.find((p) => selectedIds.has(p.id))?.id ?? photos[0]?.id
        }
      />
      <FormatConvertDialog
        onClose={() => {
          setConvertDialogOpen(false);
          clearSelection();
        }}
        onConvert={handleConvertSelected}
        open={convertDialogOpen}
        photoCount={selectedIds.size}
      />
      <AddToAlbumDialog
        elevated={lightboxIndex >= 0}
        onClose={() => setAddToAlbumOpen(false)}
        open={addToAlbumOpen}
        photoIds={addToAlbumIds}
      />
      <ExportDialog
        onClose={() => setExportDialogOpen(false)}
        open={exportDialogOpen}
        photoIds={exportIds}
      />
      <CloudUploadDialog
        onClose={() => setCloudUploadOpen(false)}
        open={cloudUploadOpen}
        photoIds={cloudUploadIds}
      />
      <ShareDialog
        onClose={() => setShareDialogOpen(false)}
        open={shareDialogOpen}
        photoIds={shareIds}
      />
      <ConfirmDeleteDialog
        count={pendingDeleteIds.length}
        onCancel={() => {
          setDeleteConfirmOpen(false);
          setPendingDeleteIds([]);
        }}
        onConfirm={executeDelete}
        open={deleteConfirmOpen}
      />
      <CullStartDialog
        defaultName={`${t("cullTitle")} · ${cullPhotoIds.length} ${t("photos")}`}
        onClose={() => setCullPhotoIds([])}
        onCreated={(sessionId) => {
          setCullPhotoIds([]);
          clearSelection();
          navigate({
            to: "/cull/$sessionId",
            params: { sessionId: String(sessionId) },
          });
        }}
        open={cullPhotoIds.length >= 2}
        photoIds={cullPhotoIds}
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
