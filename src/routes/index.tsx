import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { PhotoDetailPanel } from "@/components/PhotoDetailPanel";
import type { SortField, SortOrder } from "@/components/PhotoGrid";
import { PhotoGrid } from "@/components/PhotoGrid";
import { PhotoLightbox } from "@/components/PhotoLightbox";
import { QuickPreview } from "@/components/QuickPreview";
import {
  type ExifFilters,
  SearchBar,
  type SearchBarHandle,
} from "@/components/SearchBar";
import { SearchEmptyState } from "@/components/SearchEmptyState";
import { SelectionActionBar } from "@/components/SelectionActionBar";
import { ShareDialog } from "@/components/ShareDialog";
import { StatusBar } from "@/components/StatusBar";
import { Welcome } from "@/components/Welcome";
import { useBrowseSession } from "@/contexts/BrowseSessionContext";
import { useScrollPosition } from "@/contexts/ScrollPositionContext";
import { useSidebarFilter } from "@/contexts/SidebarFilterContext";
import { useAiStatus } from "@/hooks/useAiStatus";
import { useGlobalDropZone } from "@/hooks/useGlobalDropZone";
import { usePhotoDetailPanel } from "@/hooks/usePhotoDetailPanel";
import { usePhotoSelection } from "@/hooks/usePhotoSelection";
import { usePhotos } from "@/hooks/usePhotos";
import { useScrollRestorePreloader } from "@/hooks/useScrollRestorePreloader";
import { ipc } from "@/ipc/manager";
import { queryClient } from "@/providers/QueryProvider";
import type { Photo } from "@/types/photo";
import { preloadImagesWithConcurrency } from "@/utils/image-preloader";
import { toLocalMediaUrl } from "@/utils/local-media-url";

const GRID_SORT_FIELD_KEY = "grid_sort_field";
const GRID_SORT_ORDER_KEY = "grid_sort_order";

function loadSortField(): SortField {
  try {
    const raw = localStorage.getItem(GRID_SORT_FIELD_KEY);
    if (raw === "date" || raw === "name" || raw === "size") {
      return raw;
    }
  } catch {
    /* ignore */
  }
  return "date";
}

function loadSortOrder(): SortOrder {
  try {
    const raw = localStorage.getItem(GRID_SORT_ORDER_KEY);
    if (raw === "asc" || raw === "desc") {
      return raw;
    }
  } catch {
    /* ignore */
  }
  return "desc";
}

function HomePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const filter = useSidebarFilter();
  const { handleGlobalDragOver, handleGlobalDrop } = useGlobalDropZone();
  const aiIndexingRef = useRef(false);
  // 搜索状态：从 BrowseSessionContext 恢复，导航回来时保留搜索上下文
  const { getSession: getBrowseSession, saveSession: saveBrowseSession } =
    useBrowseSession();
  const savedSearch = getBrowseSession("home-search");
  const [searchQuery, setSearchQuery] = useState(savedSearch.searchQuery);
  const [searchMode, setSearchMode] = useState<
    "text" | "image" | "exif" | "color" | null
  >(savedSearch.searchMode as "text" | "image" | "exif" | "color" | null);
  const [searchTime, setSearchTime] = useState<number | undefined>(undefined);
  const [searchResults, setSearchResults] = useState<Photo[] | null>(null);
  const [colorHex, setColorHex] = useState<string | null>(
    savedSearch.colorHex ?? null
  );
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
  const [pendingDeleteIds, setPendingDeleteIds] = useState<number[]>([]);
  const [deletingIds, setDeletingIds] = useState<Set<number>>(new Set());
  const [searchLoading, setSearchLoading] = useState(false);
  const [sortField, setSortField] = useState<SortField>(loadSortField);
  const [sortOrder, setSortOrder] = useState<SortOrder>(loadSortOrder);
  const [quickPreviewIndex, setQuickPreviewIndex] = useState(-1);
  const [showDrillBanner, setShowDrillBanner] = useState(false);
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
  const searchBarRef = useRef<SearchBarHandle>(null);

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
      navigate({ to: "/", search: {}, replace: true });
      setSearchMode(null);
      setSearchQuery("");
      setSearchTime(undefined);
      setSearchResults(null);
      setColorHex(null);
      filter.setActiveFolderId(null); // also clears favoriteOnly + activeTagIds
      return;
    }

    // Handle tagId navigation from SpotlightSearch
    if (drillParams.tagId != null) {
      const tagId = drillParams.tagId;
      navigate({ to: "/", search: {}, replace: true });
      setSearchMode(null);
      setSearchQuery("");
      setSearchTime(undefined);
      setSearchResults(null);
      filter.setFavoriteOnly(false);
      filter.setActiveFolderId(null);
      // Set tag filter via Context — need to set activeTagIds directly
      // No direct setter exposed; use toggleTag for single tag
      filter.toggleTag(tagId);
      return;
    }

    // Handle favoriteOnly navigation from SpotlightSearch
    if (drillParams.favoriteOnly) {
      navigate({ to: "/", search: {}, replace: true });
      setSearchMode(null);
      setSearchQuery("");
      setSearchTime(undefined);
      setSearchResults(null);
      filter.setFavoriteOnly(true); // also clears activeFolderId + activeTagIds
      return;
    }

    setShowDrillBanner(true);

    // Build filters
    const filters: ExifFilters = {};
    if (drillParams.cameraModel) {
      filters.cameraModel = drillParams.cameraModel;
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
    if (drillParams.dateTo) {
      filters.dateTo = drillParams.dateTo;
    }

    // Extract optional text search query and color hex for color drill-down
    const textQuery = (drillParams.searchQuery as string) || "";
    const colorHexParam = (drillParams.colorHex as string) || undefined;

    // Sync filters to SearchBar BEFORE clearing URL params
    if (searchBarRef.current) {
      searchBarRef.current.setFilters(filters, true);
    }

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

  // Listen for sidebar-triggered clear-search events
  useEffect(() => {
    function handler() {
      setSearchMode(null);
      setSearchQuery("");
      setSearchTime(undefined);
      setSearchResults(null);
    }
    window.addEventListener("sidebar:clear-search", handler);
    return () => window.removeEventListener("sidebar:clear-search", handler);
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
      if (event.data?.channel === "scan-progress") {
        if (filter.importPhaseRef.current !== "scanning") {
          return;
        }
        const { scanned, total, phase } = event.data;
        if (phase === "indexing") {
          filter.setScanProgress(t("scanningIndexing", { scanned, total }));
        } else if (phase === "complete") {
          filter.setScanProgress(t("scanningCompleteShort", { total }));
        }
      }
      if (event.data?.channel === "ai-progress") {
        const { processed, total, phase } = event.data;
        aiIndexingRef.current = phase === "loading" || phase === "embedding";
        if (
          aiIndexingRef.current &&
          filter.importPhaseRef.current === "scanning"
        ) {
          filter.setScanProgress(
            phase === "loading"
              ? t("aiIndexingStarted")
              : t("aiIndexingProgress", { processed, total })
          );
        }
      }
      if (event.data?.channel === "ai-auto-repair-started") {
        toast.info(
          "检测到向量数据库损坏，已自动重建。索引进度可在侧边栏查看。"
        );
      }
      if (event.data?.channel === "ai-embedding-done") {
        aiIndexingRef.current = false;
        filter.setImportPhase("idle");
        if (event.data?.error) {
          filter.setScanProgress(`AI 索引失败: ${event.data.error}`);
        } else {
          filter.setScanProgress("");
        }
        queryClient.invalidateQueries({ queryKey: ["aiStatus"] });
      }
      if (event.data?.channel === "ai-status-changed") {
        queryClient.invalidateQueries({ queryKey: ["aiStatus"] });
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [t, filter.importPhaseRef, filter.setImportPhase, filter.setScanProgress]);

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

  const { data: aiStatus } = useAiStatus();

  // Flatten paginated photos
  const pagedPhotos = useMemo(
    () => photosData?.pages.flatMap((p) => p.items) ?? [],
    [photosData]
  );
  const totalFromQuery = photosData?.pages[0]?.total ?? 0;

  // ── 缩略图预加载（视口优先级排序 + 并发限流 + 追踪上限防内存泄露）───
  // 问题：FIFO 顺序导致可见区域图片被排到队尾，快速滚动时首屏白屏。
  // 方案：获取当前视口锚点索引，按距离视口的远近升序排列 newUrls，
  // 确保离用户最近的图片优先进入 12 个并发加载槽。
  const MAX_PRELOAD_TRACKED = 500;
  const preloadedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const newEntries: Array<{ url: string; idx: number }> = [];
    for (let i = 0; i < pagedPhotos.length; i++) {
      const photo = pagedPhotos[i];
      const filePath = photo.thumbnailPath ?? photo.path;
      if (!preloadedRef.current.has(filePath)) {
        if (preloadedRef.current.size >= MAX_PRELOAD_TRACKED) {
          const oldest = preloadedRef.current.values().next().value;
          if (oldest) {
            preloadedRef.current.delete(oldest);
          }
        }
        preloadedRef.current.add(filePath);
        newEntries.push({ url: toLocalMediaUrl(filePath), idx: i });
      }
    }
    if (newEntries.length > 0) {
      // ── 视口优先级排序 ──────────────────────────────────
      // 获取当前可见区域的第一个 item 索引，作为距离计算锚点。
      // gridRef 未挂载时降级为 FIFO（保持原有行为）。
      const anchor = gridRef.current?.getCurrentAnchor();
      const visibleStartIdx = anchor?.estimatedGlobalIndex ?? -1;

      if (visibleStartIdx >= 0 && newEntries.length > 1) {
        // 按距离视口的远近升序排列
        newEntries.sort(
          (a, b) =>
            Math.abs(a.idx - visibleStartIdx) -
            Math.abs(b.idx - visibleStartIdx)
        );
      }
      preloadImagesWithConcurrency(
        newEntries.map((e) => e.url),
        12
      );
    }
  }, [pagedPhotos]);

  // Active photo list: search results or paginated query
  const photos = isSearching ? (searchResults ?? []) : pagedPhotos;
  const photosRef = useRef(photos);
  photosRef.current = photos;

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
    const saved = getBrowseSession("home-search");
    if (saved.searchQuery || saved.searchMode === "color" || saved.colorHex) {
      restoredSearchRef.current = true;
      const q = saved.searchQuery;
      setSearchQuery(q);
      if (saved.searchMode) {
        setSearchMode(saved.searchMode);
      }
      if (saved.colorHex) {
        setColorHex(saved.colorHex);
      }
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
      fetchNextPage();
    }
  }, [
    preloadState,
    hasNextPage,
    isFetchingNextPage,
    isSearching,
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
          onClearFilters={() => searchBarRef.current?.clearFilters()}
          onClearSearch={() => {
            setSearchQuery("");
            setColorHex(null);
            setSearchMode(null);
            setSearchTime(undefined);
            setSearchResults(null);
            setParsedTimeFilter(null);
            setShowAiIndexHint(false);
            filter.setActiveFolderId(null);
            searchBarRef.current?.clearFilters();
          }}
          onGoToAiSettings={() => navigate({ to: "/settings" })}
          parsedTimeFilter={parsedTimeFilter}
          query={searchQuery}
          searchMode={searchMode}
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
    navigate,
  ]);

  const handleEndReached = useCallback(() => {
    if (!isSearching && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [isSearching, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const handleToggleFavorite = useCallback(async (id: number) => {
    const photo = photosRef.current.find((p) => p.id === id);
    if (!photo) {
      return;
    }
    const prevVal = !!photo.isFavorite;
    const newVal = !prevVal;
    await ipc.client.photos.toggleFavorite({ ids: [id], favorite: newVal });
    queryClient.invalidateQueries({ queryKey: ["photos"] });
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
            queryClient.invalidateQueries({ queryKey: ["photos"] });
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
    setSearchQuery(query);
    if (paramColorHex !== undefined) {
      setColorHex(paramColorHex);
    }
    const hasFilters = filters && Object.values(filters).some((v) => v);
    const hasColorHex = !!effectiveColorHex;

    if (!(query.trim() || hasFilters || hasColorHex)) {
      setSearchMode(null);
      setSearchTime(undefined);
      setSearchResults(null);
      return;
    }

    const startTime = performance.now();
    setSearchMode(hasColorHex ? "color" : query.trim() ? "text" : "exif");
    setSearchLoading(true);

    try {
      const searchParams: {
        query?: string;
        colorHex?: string;
        dateFrom?: number;
        dateTo?: number;
        cameraModel?: string;
        lensModel?: string;
        focalMin?: number;
        focalMax?: number;
        apertureMin?: number;
        apertureMax?: number;
        isoMin?: number;
        isoMax?: number;
        shutterMin?: number;
        shutterMax?: number;
        limit: number;
      } = { limit: 500 };
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
      if (filters?.dateTo) {
        const [y, m, d] = filters.dateTo.split("-").map(Number);
        searchParams.dateTo = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
      }
      if (filters?.cameraModel) {
        searchParams.cameraModel = filters.cameraModel;
      }
      if (filters?.lensModel) {
        searchParams.lensModel = filters.lensModel;
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

      const result = (await ipc.client.photos.searchCompound(
        searchParams
      )) as any;
      const results = result.results || [];

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
          setSearchResults((fallback as any).items || []);
          setSearchTime(Math.round(performance.now() - startTime));
        } catch {
          toast.error(t("toastSearchFailed"));
          setSearchResults([]);
        }
      }
    } finally {
      setSearchLoading(false);
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
        queryClient.invalidateQueries({ queryKey: ["photos"] });
      }
      toast.success(t("toastDeletedCount", { count }));
    } catch {
      toast.error(t("toastDeleteFailed"));
    }
  }

  async function handleRenameSelected(pattern: string) {
    const ids = Array.from(selectedIds);
    try {
      const result = await ipc.client.photos.renamePhotos({ ids, pattern });
      queryClient.invalidateQueries({ queryKey: ["photos"] });
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
    setSearchQuery(t("imageSearchToken"));
    setSearchMode("image");
    setSearchLoading(true);
    const startTime = performance.now();
    try {
      const result = await ipc.client.photos.searchByImage({
        imagePath,
        limit: 500,
      });
      if (result.error) {
        console.warn("[ImageSearch]", result.error);
      }
      const results = (result as any).results || [];
      setSearchResults(results);
      setSearchTime(Math.round(performance.now() - startTime));
    } catch (err: any) {
      console.error("[ImageSearch] failed:", err?.message || err);
      toast.error(t("toastImageSearchFailed"));
      setSearchResults([]);
      setSearchTime(Math.round(performance.now() - startTime));
    } finally {
      setSearchLoading(false);
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
          queryClient.invalidateQueries({ queryKey: ["photos"] });
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
                  queryClient.invalidateQueries({ queryKey: ["photos"] });
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
    try {
      localStorage.setItem(GRID_SORT_FIELD_KEY, s);
      localStorage.setItem(GRID_SORT_ORDER_KEY, o);
    } catch {
      /* ignore */
    }
  }, []);

  const hasPhotos =
    photos.length > 0 ||
    (loading && photos.length === 0) ||
    isSearching ||
    filter.favoriteOnly;

  return (
    <>
      <div
        className="flex h-full min-w-0 flex-col"
        onDragOver={handleGlobalDragOver}
        onDrop={handleGlobalDrop}
      >
        <SearchBar
          aiStatus={aiStatus ?? null}
          colorHex={colorHex ?? undefined}
          imageSearchActive={searchMode === "image"}
          onClear={() => {
            setSearchQuery("");
            setColorHex(null);
            setSearchMode(null);
            setSearchTime(undefined);
            setSearchResults(null);
            setParsedTimeFilter(null);
            setShowAiIndexHint(false);
          }}
          onImageSearch={handleImageSearch}
          onSearch={handleSearch}
          ref={searchBarRef}
          resultCount={searchQuery ? photos.length : undefined}
          searchMode={searchMode}
          searchTime={searchTime}
        />
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
                  searchBarRef.current?.clearFilters();
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
        {hasPhotos ? (
          <div className="flex min-h-0 flex-1">
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
                onSelect={handleSelect}
                onSortChange={handleSortChange}
                onToggleFavorite={handleToggleFavorite}
                photos={photos}
                routeKey={routeKey}
                searchQuery={searchQuery}
                selectedIds={selectedIds}
                sort={sortField}
                sortOrder={sortOrder}
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
                onStartCull={async () => {
                  const ids = Array.from(selectedIds);
                  if (ids.length < 2) {
                    return;
                  }
                  try {
                    const session = (await ipc.client.cull.createSession({
                      name: `${t("cullTitle")} · ${ids.length} ${t("photos")}`,
                      mode: "duel",
                      photoIds: ids,
                    })) as { id: number };
                    clearSelection();
                    navigate({
                      to: "/cull/$sessionId",
                      params: { sessionId: String(session.id) },
                    });
                  } catch {
                    toast.error("Failed to create cull session");
                  }
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
                      queryClient.invalidateQueries({ queryKey: ["photos"] });
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
              />
            </div>
            <PhotoDetailPanel
              onClose={() => {
                dismissDetail();
                clearSelection();
              }}
              onNavigate={navigateDetail}
              onOpenExplorer={handleOpenExplorer}
              photo={detailPhoto}
            />
          </div>
        ) : (
          <Welcome
            disabled={filter.importPhase !== "idle"}
            onAddFolder={filter.handleAddFolder}
          />
        )}
        <StatusBar
          aiStatus={aiStatus ?? null}
          selectedCount={selectedIds.size}
          totalPhotos={totalPhotos}
        />
      </div>
      {lightboxIndex >= 0 && (
        <PhotoLightbox
          index={lightboxIndex}
          onClose={(currentIndex) => {
            setLightboxIndex(-1);
            if (currentIndex >= 0 && currentIndex < photos.length) {
              const photo = photos[currentIndex];
              handleKeyboardSelect(photo.id);
            }
          }}
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
              queryClient.invalidateQueries({ queryKey: ["photos"] });
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
                      queryClient.invalidateQueries({ queryKey: ["photos"] });
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
    lensModel?: string;
    dateFrom?: string;
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
    lensModel: search.lensModel as string | undefined,
    dateFrom: search.dateFrom as string | undefined,
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
