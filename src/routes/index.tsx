import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AddToAlbumDialog } from "@/components/AddToAlbumDialog";
import { BatchRenameDialog } from "@/components/BatchRenameDialog";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { ExportDialog } from "@/components/ExportDialog";
import { FormatConvertDialog } from "@/components/FormatConvertDialog";
import type { MenuState } from "@/components/PhotoContextMenu";
import { PhotoContextMenu } from "@/components/PhotoContextMenu";
import { PhotoDetailPanel } from "@/components/PhotoDetailPanel";
import { PhotoGrid } from "@/components/PhotoGrid";
import type { SortField, SortOrder } from "@/components/PhotoGrid";
import { PhotoLightbox } from "@/components/PhotoLightbox";
import { SelectionActionBar } from "@/components/SelectionActionBar";
import { QuickPreview } from "@/components/QuickPreview";
import type { ExifFilters } from "@/components/SearchBar";
import { SearchBar } from "@/components/SearchBar";
import { Sidebar } from "@/components/Sidebar";
import { StatusBar } from "@/components/StatusBar";
import { Welcome } from "@/components/Welcome";
import { useAiStatus } from "@/hooks/useAiStatus";
import { useFolders } from "@/hooks/useFolders";
import { usePhotos } from "@/hooks/usePhotos";
import { ipc } from "@/ipc/manager";
import { queryClient } from "@/providers/QueryProvider";
import type { Photo } from "@/types/photo";

const SIDEBAR_COLLAPSED_KEY = "sidebar_collapsed";

function loadSidebarState(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

function HomePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [activeFolderId, setActiveFolderId] = useState<number | null>(null);
  const [activeTagId, setActiveTagId] = useState<number | null>(null);
  const [scanningFolder, setScanningFolder] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState<
    "text" | "image" | "exif" | null
  >(null);
  const [searchTime, setSearchTime] = useState<number | undefined>(undefined);
  const [searchResults, setSearchResults] = useState<Photo[] | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState(-1);
  const [lastClickedIdx, setLastClickedIdx] = useState(-1);
  const [detailPhoto, setDetailPhoto] = useState<Photo | null>(null);
  const [detailDismissed, setDetailDismissed] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(loadSidebarState);
  const [ctxMenu, setCtxMenu] = useState<MenuState>({
    open: false,
    x: 0,
    y: 0,
    photoId: null,
    photoPath: null,
  });
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [convertDialogOpen, setConvertDialogOpen] = useState(false);
  const [addToAlbumOpen, setAddToAlbumOpen] = useState(false);
  const [addToAlbumIds, setAddToAlbumIds] = useState<number[]>([]);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportIds, setExportIds] = useState<number[]>([]);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [pendingDeleteIds, setPendingDeleteIds] = useState<number[]>([]);
  const [deletingIds, setDeletingIds] = useState<Set<number>>(new Set());
  const [searchLoading, setSearchLoading] = useState(false);
  const [sortField, setSortField] = useState<SortField>("date");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [quickPreviewIndex, setQuickPreviewIndex] = useState(-1);
  const [favoriteOnly, setFavoriteOnly] = useState(false);

  // --- TanStack Query hooks ---
  const isSearching = searchMode !== null;

  // Drill-down from dashboard: detect search params and auto-trigger EXIF search
  const drillParams = Route.useSearch();
  const drillConsumed = useRef(false);

  useEffect(() => {
    if (drillConsumed.current) return;
    const hasParams = Object.values(drillParams).some((v) => v !== undefined);
    if (!hasParams) return;
    drillConsumed.current = true;

    // Build filters and trigger search
    const filters: ExifFilters = {};
    if (drillParams.cameraModel) filters.cameraModel = drillParams.cameraModel;
    if (drillParams.focalMin) filters.focalMin = drillParams.focalMin;
    if (drillParams.focalMax) filters.focalMax = drillParams.focalMax;
    if (drillParams.apertureMin) filters.apertureMin = drillParams.apertureMin;
    if (drillParams.apertureMax) filters.apertureMax = drillParams.apertureMax;
    if (drillParams.isoMin) filters.isoMin = drillParams.isoMin;
    if (drillParams.isoMax) filters.isoMax = drillParams.isoMax;

    // Clear URL params and trigger search
    navigate({ to: "/", search: {}, replace: true });
    handleSearch("", filters);
  }, [drillParams]); // eslint-disable-line react-hooks/exhaustive-deps

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
        queryClient.invalidateQueries({ queryKey: ["photos"] });
        queryClient.invalidateQueries({ queryKey: ["folders"] });
      }
      if (event.data?.channel === "scan-progress") {
        const { scanned, total, phase } = event.data;
        if (phase === "indexing") {
          setScanProgress(`正在索引 ${scanned}/${total}`);
        } else if (phase === "complete") {
          setScanProgress(`索引完成 (${total} 张)`);
        }
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const {
    data: photosData,
    fetchNextPage,
    hasNextPage,
    isLoading: photosLoading,
    isFetchingNextPage,
  } = usePhotos({
    folderId: activeFolderId,
    tagId: activeTagId,
    favoriteOnly: favoriteOnly || undefined,
    sort: sortField,
    order: sortOrder,
    enabled: !isSearching,
  });

  const { data: folders = [] } = useFolders();
  const { data: aiStatus } = useAiStatus();

  // Flatten paginated photos
  const pagedPhotos = useMemo(
    () => photosData?.pages.flatMap((p) => p.items) ?? [],
    [photosData]
  );
  const totalFromQuery = photosData?.pages[0]?.total ?? 0;

  // Active photo list: search results or paginated query
  const photos = isSearching ? (searchResults ?? []) : pagedPhotos;
  const totalPhotos = isSearching ? photos.length : totalFromQuery;
  const loading = isSearching ? searchLoading : photosLoading;

  const emptyStateContent = useMemo(() => {
    if (isSearching) {
      return (
        <div className="flex flex-col items-center gap-3 text-center">
          <svg className="h-10 w-10 text-muted-foreground/40" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" strokeLinecap="round" />
          </svg>
          <p className="font-[510] text-[14px] text-foreground">未找到匹配的照片</p>
          <p className="max-w-[280px] text-[12px] text-muted-foreground/70">
            试试换个关键词，或使用 EXIF 筛选器缩小范围
          </p>
        </div>
      );
    }
    if (favoriteOnly) {
      return (
        <div className="flex flex-col items-center gap-3 text-center">
          <svg className="h-10 w-10 text-muted-foreground/40" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <p className="font-[510] text-[14px] text-foreground">还没有收藏的照片</p>
          <p className="max-w-[280px] text-[12px] text-muted-foreground/70">
            浏览照片时点击星标即可收藏，收藏的照片会出现在这里
          </p>
        </div>
      );
    }
    return undefined;
  }, [isSearching, favoriteOnly]);

  const handleEndReached = useCallback(() => {
    if (!isSearching && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [isSearching, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const handleToggleFavorite = useCallback(
    async (id: number) => {
      const photo = photos.find((p) => p.id === id);
      if (!photo) return;
      const prevVal = !!photo.isFavorite;
      const newVal = !prevVal;
      await ipc.client.photos.toggleFavorite({ ids: [id], favorite: newVal });
      queryClient.invalidateQueries({ queryKey: ["photos"] });
      toast.success(newVal ? "已收藏" : "已取消收藏", {
        action: {
          label: "撤销",
          onClick: async () => {
            await ipc.client.photos.toggleFavorite({ ids: [id], favorite: prevVal });
            queryClient.invalidateQueries({ queryKey: ["photos"] });
          },
        },
      });
    },
    [photos],
  );

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  // Auto-collapse sidebar when window is narrow
  const autoCollapsedRef = useRef(false);
  useEffect(() => {
    function handleResize() {
      const narrow = window.innerWidth < 900;
      if (narrow && !sidebarCollapsed) {
        autoCollapsedRef.current = true;
        setSidebarCollapsed(true);
      } else if (!narrow && autoCollapsedRef.current) {
        autoCollapsedRef.current = false;
        setSidebarCollapsed(loadSidebarState());
      }
    }
    window.addEventListener("resize", handleResize);
    handleResize();
    return () => window.removeEventListener("resize", handleResize);
  }, [sidebarCollapsed]);

  // Sync detail panel with selection
  const prevSelectedIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (selectedIds.size === 1) {
      const id = selectedIds.values().next().value as number;
      // Reset dismissed state when selection changes to a different photo
      if (id !== prevSelectedIdRef.current) {
        setDetailDismissed(false);
        prevSelectedIdRef.current = id;
      }
      if (!detailDismissed) {
        const photo = photos.find((p) => p.id === id);
        setDetailPhoto(photo || null);
      }
    } else {
      setDetailPhoto(null);
      prevSelectedIdRef.current = null;
    }
  }, [selectedIds, photos, detailDismissed]);

  function handleSelectTag(tagId: number | null) {
    setActiveTagId(tagId);
    if (tagId !== null) {
      setFavoriteOnly(false);
    }
  }

  async function handleAddFolder() {
    const result = await ipc.client.shell.openFolderDialog({});
    const folderPath = result?.path;
    if (!folderPath) {
      return;
    }

    setScanningFolder(folderPath);
    setScanProgress(t("scanningProgress", { scanned: 0, total: "?" }));
    try {
      const scanResult = await ipc.client.photos.scanFolder({
        path: folderPath,
      });
      const skipped = scanResult.skipped || 0;
      const count = scanResult.photoIds?.length || 0;
      setScanProgress(
        skipped > 0
          ? t("scanningSkipped", { count, skipped })
          : t("scanningComplete", { count }),
      );
      toast.success(`已索引 ${count} 张照片${skipped > 0 ? `，跳过 ${skipped} 张` : ""}`);
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      queryClient.invalidateQueries({ queryKey: ["photos"] });
    } catch {
      setScanProgress("");
      toast.error("扫描文件夹失败");
    } finally {
      setScanningFolder(null);
      setTimeout(() => setScanProgress(""), 3000);
    }
  }
  async function handleDeleteFolder(id: number) {
    try {
      await ipc.client.photos.deleteFolder({ id });
      if (activeFolderId === id) {
        setActiveFolderId(null);
      }
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      queryClient.invalidateQueries({ queryKey: ["photos"] });
      toast.success("已移除文件夹");
    } catch {
      toast.error("删除文件夹失败");
    }
  }

  const handleSelect = useCallback(
    (id: number, event: React.MouseEvent) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        const idx = photos.findIndex((p) => p.id === id);
        if (event.shiftKey && lastClickedIdx >= 0 && idx >= 0) {
          const [from, to] =
            lastClickedIdx < idx
              ? [lastClickedIdx, idx]
              : [idx, lastClickedIdx];
          for (let i = from; i <= to; i++) {
            next.add(photos[i].id);
          }
        } else if (event.ctrlKey || event.metaKey) {
          next.has(id) ? next.delete(id) : next.add(id);
          if (idx >= 0) {
            setLastClickedIdx(idx);
          }
        } else {
          next.clear();
          next.add(id);
          if (idx >= 0) {
            setLastClickedIdx(idx);
          }
        }
        return next;
      });
    },
    [photos, lastClickedIdx]
  );

  const handleDoubleClick = useCallback(
    (id: number) => {
      const idx = photos.findIndex((p) => p.id === id);
      if (idx >= 0) {
        setLightboxIndex(idx);
      }
    },
    [photos]
  );
  async function handleSearch(query: string, filters?: ExifFilters) {
    setSearchQuery(query);
    const hasFilters = filters && Object.values(filters).some((v) => v);

    if (!(query.trim() || hasFilters)) {
      setSearchMode(null);
      setSearchTime(undefined);
      setSearchResults(null);
      return;
    }

    const startTime = performance.now();
    setSearchMode(query.trim() ? "text" : "exif");
    setSearchLoading(true);

    try {
      const searchParams: {
        query?: string;
        dateFrom?: number;
        dateTo?: number;
        cameraModel?: string;
        focalMin?: number;
        focalMax?: number;
        apertureMin?: number;
        apertureMax?: number;
        isoMin?: number;
        isoMax?: number;
        limit: number;
      } = { limit: 100 };
      if (query.trim()) {
        searchParams.query = query.trim();
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

      const result = await ipc.client.photos.searchCompound(searchParams);
      setSearchResults((result as any).results || []);
      setSearchTime(Math.round(performance.now() - startTime));
    } catch {
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
        toast.error("搜索失败");
        setSearchResults([]);
      }
    } finally {
      setSearchLoading(false);
    }
  }
  function handleContextMenu(e: React.MouseEvent) {
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
    setCtxMenu({
      open: true,
      x: e.clientX,
      y: e.clientY,
      photoId: id,
      photoPath: path,
    });
  }

  async function handleOpenExplorer(filePath: string) {
    await ipc.client.shell.openInExplorer({ path: filePath });
  }

  function handleDetailNavigate(direction: "prev" | "next") {
    if (!detailPhoto) return;
    const currentIdx = photos.findIndex((p) => p.id === detailPhoto.id);
    if (currentIdx < 0) return;
    const nextIdx = direction === "prev" ? currentIdx - 1 : currentIdx + 1;
    if (nextIdx < 0 || nextIdx >= photos.length) return;
    const nextPhoto = photos[nextIdx];
    setSelectedIds(new Set([nextPhoto.id]));
    setLastClickedIdx(nextIdx);
    setDetailDismissed(false);
    setDetailPhoto(nextPhoto);
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
      setSelectedIds((prev) => {
        const n = new Set(prev);
        for (const id of ids) n.delete(id);
        return n;
      });
      if (isSearching) {
        setSearchResults(
          (prev) => prev?.filter((p) => !ids.includes(p.id)) ?? null
        );
      } else {
        queryClient.invalidateQueries({ queryKey: ["photos"] });
      }
      toast.success(`已删除 ${count} 张照片`);
    } catch {
      toast.error("删除照片失败");
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
          ? `已重命名 ${r.renamed} 张，${r.errors} 张失败`
          : `已重命名 ${r.renamed} 张照片`,
      );
      return r;
    } catch {
      toast.error("重命名失败");
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
      toast.success(`已转换 ${r.converted} 张照片`);
      return r;
    } catch {
      toast.error("格式转换失败");
      return { converted: 0, outputDir: options.outputDir };
    }
  }

  async function handleImageSearch(imagePath: string) {
    setSearchQuery("[以图搜图]");
    setSearchMode("image");
    setSearchLoading(true);
    const startTime = performance.now();
    try {
      const result = await ipc.client.photos.searchByImage({
        imagePath,
        limit: 100,
      });
      if (result.error) {
        console.warn("[ImageSearch]", result.error);
      }
      const results = (result as any).results || [];
      setSearchResults(results);
      setSearchTime(Math.round(performance.now() - startTime));
    } catch (err: any) {
      console.error("[ImageSearch] failed:", err?.message || err);
      toast.error("以图搜图失败");
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
        setSelectedIds(new Set(photos.map((p) => p.id)));
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
          setSelectedIds(new Set());
          return;
        }
      }

      if (e.key === " " && selectedIds.size > 0 && quickPreviewIndex < 0) {
        e.preventDefault();
        const firstId = selectedIds.values().next().value as number;
        const idx = photos.findIndex((p) => p.id === firstId);
        if (idx >= 0) setQuickPreviewIndex(idx);
        return;
      }

      if (e.key === "f" && selectedIds.size > 0 && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const ids = [...selectedIds];
        const allFav = ids.every((id) => photos.find((p) => p.id === id)?.isFavorite);
        const newVal = !allFav;
        ipc.client.photos.toggleFavorite({ ids, favorite: newVal }).then(() => {
          queryClient.invalidateQueries({ queryKey: ["photos"] });
          toast.success(newVal ? `已收藏 ${ids.length} 张` : "已取消收藏", {
            action: {
              label: "撤销",
              onClick: async () => {
                await ipc.client.photos.toggleFavorite({ ids, favorite: allFav });
                queryClient.invalidateQueries({ queryKey: ["photos"] });
              },
            },
          });
        });
        return;
      }

      if (e.key === "i" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (detailPhoto) {
          setDetailDismissed(true);
          setDetailPhoto(null);
        } else if (selectedIds.size === 1) {
          setDetailDismissed(false);
          const id = selectedIds.values().next().value as number;
          const p = photos.find((ph) => ph.id === id);
          if (p) setDetailPhoto(p);
        }
        return;
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [photos, selectedIds, renameDialogOpen, convertDialogOpen, quickPreviewIndex]);

  const hasPhotos =
    photos.length > 0 ||
    (loading && photos.length === 0) ||
    isSearching ||
    favoriteOnly;

  return (
    <div className="flex h-full">
      <Sidebar
        activeFolderId={activeFolderId}
        collapsed={sidebarCollapsed}
        favoriteActive={favoriteOnly}
        folders={folders}
        onAddFolder={handleAddFolder}
        onDeleteFolder={handleDeleteFolder}
        onSelectFavorites={() => {
          setFavoriteOnly((v) => !v);
          setActiveFolderId(null);
          setActiveTagId(null);
        }}
        onSelectFolder={(id) => {
          setActiveFolderId(id);
          setFavoriteOnly(false);
        }}
        onSelectTag={handleSelectTag}
        onToggleCollapse={toggleSidebar}
        scanningFolder={scanningFolder}
        scanProgress={scanProgress}
        totalPhotos={totalPhotos}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <SearchBar
          aiStatus={aiStatus ?? null}
          imageSearchActive={searchQuery.startsWith("[以图搜图]")}
          onClear={() => {
            setSearchQuery("");
            setSearchMode(null);
            setSearchTime(undefined);
            setSearchResults(null);
          }}
          onImageSearch={handleImageSearch}
          onSearch={handleSearch}
          resultCount={searchQuery ? photos.length : undefined}
          searchMode={searchMode}
          searchTime={searchTime}
        />
        {hasPhotos ? (
          <div className="flex min-h-0 flex-1">
            <div className="relative flex min-w-0 flex-1">
              <PhotoGrid
                deletingIds={deletingIds}
                emptyState={emptyStateContent}
                loading={loading}
                onContextMenu={handleContextMenu}
                onDoubleClick={handleDoubleClick}
                onEndReached={handleEndReached}
                onKeyboardSelect={(id) => {
                  setSelectedIds(new Set([id]));
                  const idx = photos.findIndex((p) => p.id === id);
                  if (idx >= 0) setLastClickedIdx(idx);
                }}
                onMarqueeSelect={(ids) => {
                  if (ids.size > 0) setSelectedIds(ids);
                }}
                onSelect={handleSelect}
                onSortChange={(s, o) => {
                  setSortField(s);
                  setSortOrder(o);
                }}
                onToggleFavorite={handleToggleFavorite}
                photos={photos}
                searchQuery={searchQuery}
                selectedIds={selectedIds}
                sort={sortField}
                sortOrder={sortOrder}
              />
              <SelectionActionBar
                allFavorite={
                  selectedIds.size > 0 &&
                  [...selectedIds].every((id) => photos.find((p) => p.id === id)?.isFavorite)
                }
                onAddToAlbum={() => {
                  setAddToAlbumIds(Array.from(selectedIds));
                  setAddToAlbumOpen(true);
                }}
                onClearSelection={() => setSelectedIds(new Set())}
                onConvert={() => setConvertDialogOpen(true)}
                onDelete={handleDeleteSelected}
                onExport={handleExportSelected}
                onRename={() => setRenameDialogOpen(true)}
                onToggleFavorite={() => {
                  const ids = [...selectedIds];
                  const allFav = ids.every((id) => photos.find((p) => p.id === id)?.isFavorite);
                  const newVal = !allFav;
                  ipc.client.photos.toggleFavorite({ ids, favorite: newVal }).then(() => {
                    queryClient.invalidateQueries({ queryKey: ["photos"] });
                    toast.success(newVal ? `已收藏 ${ids.length} 张` : "已取消收藏", {
                      action: {
                        label: "撤销",
                        onClick: async () => {
                          await ipc.client.photos.toggleFavorite({ ids, favorite: allFav });
                          queryClient.invalidateQueries({ queryKey: ["photos"] });
                        },
                      },
                    });
                  });
                }}
                selectedCount={selectedIds.size}
              />
            </div>
            <PhotoDetailPanel
              onClose={() => {
                setDetailDismissed(true);
                setDetailPhoto(null);
              }}
              onNavigate={handleDetailNavigate}
              onOpenExplorer={handleOpenExplorer}
              photo={detailPhoto}
            />
          </div>
        ) : (
          <Welcome onAddFolder={handleAddFolder} />
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
              setSelectedIds(new Set([photo.id]));
              setLastClickedIdx(currentIndex);
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
              if (next < 0 || next >= photos.length) return prev;
              setSelectedIds(new Set([photos[next].id]));
              return next;
            });
          }}
          photo={photos[quickPreviewIndex]}
        />
      )}
      <PhotoContextMenu
        menu={ctxMenu}
        onAddToAlbum={handleAddToAlbum}
        onClose={() => setCtxMenu((prev) => ({ ...prev, open: false }))}
        onDelete={handleDeletePhoto}
        onExport={handleExportPhoto}
        onOpenExplorer={handleOpenExplorer}
        onToggleFavorite={handleToggleFavorite}
      />
      <BatchRenameDialog
        onClose={() => {
          setRenameDialogOpen(false);
          setSelectedIds(new Set());
        }}
        onRename={handleRenameSelected}
        open={renameDialogOpen}
        photoCount={selectedIds.size}
        sampleFilename={photos.find((p) => selectedIds.has(p.id))?.filename ?? photos[0]?.filename ?? "photo.jpg"}
        samplePhotoId={photos.find((p) => selectedIds.has(p.id))?.id ?? photos[0]?.id}
      />
      <FormatConvertDialog
        onClose={() => {
          setConvertDialogOpen(false);
          setSelectedIds(new Set());
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
      <ConfirmDeleteDialog
        count={pendingDeleteIds.length}
        onCancel={() => {
          setDeleteConfirmOpen(false);
          setPendingDeleteIds([]);
        }}
        onConfirm={executeDelete}
        open={deleteConfirmOpen}
      />
    </div>
  );
}

export const Route = createFileRoute("/")({
  component: HomePage,
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    apertureMax?: string;
    apertureMin?: string;
    cameraModel?: string;
    focalMax?: string;
    focalMin?: string;
    isoMax?: string;
    isoMin?: string;
  } => ({
    apertureMax: search.apertureMax as string | undefined,
    apertureMin: search.apertureMin as string | undefined,
    cameraModel: search.cameraModel as string | undefined,
    focalMax: search.focalMax as string | undefined,
    focalMin: search.focalMin as string | undefined,
    isoMax: search.isoMax as string | undefined,
    isoMin: search.isoMin as string | undefined,
  }),
});
