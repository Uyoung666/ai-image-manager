import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AddToAlbumDialog } from "@/components/AddToAlbumDialog";
import { BatchRenameDialog } from "@/components/BatchRenameDialog";
import { ExportDialog } from "@/components/ExportDialog";
import { FormatConvertDialog } from "@/components/FormatConvertDialog";
import type { MenuState } from "@/components/PhotoContextMenu";
import { PhotoContextMenu } from "@/components/PhotoContextMenu";
import { PhotoDetailPanel } from "@/components/PhotoDetailPanel";
import { PhotoGrid } from "@/components/PhotoGrid";
import { PhotoLightbox } from "@/components/PhotoLightbox";
import type { ExifFilters } from "@/components/SearchBar";
import { SearchBar } from "@/components/SearchBar";
import { Sidebar } from "@/components/Sidebar";
import { Welcome } from "@/components/Welcome";
import type { AiReadiness } from "@/services/ai-embedder";
import { ipc } from "@/ipc/manager";

interface Photo {
  filename: string;
  fileSize: number;
  height: number;
  id: number;
  isIndexed: boolean;
  path: string;
  thumbnailPath: string | null;
  width: number;
}
interface Folder {
  displayName: string;
  id: number;
  path: string;
  photoCount: number;
}

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
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [totalPhotos, setTotalPhotos] = useState(0);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [activeFolderId, setActiveFolderId] = useState<number | null>(null);
  const [activeTagId, setActiveTagId] = useState<number | null>(null);
  const [scanningFolder, setScanningFolder] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState<"text" | "image" | "exif" | null>(null);
  const [searchTime, setSearchTime] = useState<number | undefined>(undefined);
  const [lightboxIndex, setLightboxIndex] = useState(-1);
  const [lastClickedIdx, setLastClickedIdx] = useState(-1);
  const [detailPhoto, setDetailPhoto] = useState<Photo | null>(null);
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
  const [aiStatus, setAiStatus] = useState<{
    model: string;
    vectorDB: string;
    hasVectors: boolean;
    vectorCount: number;
    indexReady: boolean;
    isEmbedding: boolean;
    embeddingProgress: { processed: number; total: number; phase: string };
  } | null>(null);

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

  const loadFolders = useCallback(async () => {
    try {
      const result = await ipc.client.photos.getFolders({});
      setFolders(result as Folder[]);
    } catch {
      /* ignore */
    }
  }, []);

  const loadPhotos = useCallback(
    async (showLoading = false) => {
      if (showLoading) {
        setLoading(true);
      }
      try {
        const result = await ipc.client.photos.listPhotos({
          folderId: activeFolderId || undefined,
          tagId: activeTagId || undefined,
          sort: "date",
          order: "desc",
          offset: 0,
          limit: 500,
        });
        setPhotos((result as any).items || []);
        setTotalPhotos((result as any).total || 0);
      } catch {
        /* ignore */
      } finally {
        if (showLoading) {
          setLoading(false);
        }
      }
    },
    [activeFolderId, activeTagId]
  );

  useEffect(() => {
    loadFolders();
    loadPhotos(true);
  }, [loadPhotos, loadFolders]);

  // Poll AI readiness every 3s so search bar can show accurate state
  useEffect(() => {
    let running = true;
    async function poll() {
      try {
        const status = await ipc.client.photos.getAiStatus({});
        if (running) setAiStatus(status);
      } catch { /* ignore */ }
    }
    poll();
    const iv = setInterval(poll, 3000);
    return () => { running = false; clearInterval(iv); };
  }, []);

  // Sync detail panel with selection
  useEffect(() => {
    if (selectedIds.size === 1) {
      const id = selectedIds.values().next().value as number;
      const photo = photos.find((p) => p.id === id);
      setDetailPhoto(photo || null);
    } else {
      setDetailPhoto(null);
    }
  }, [selectedIds, photos]);

  function handleSelectTag(tagId: number | null) {
    setActiveTagId(tagId);
    // When selecting a tag, deselect the folder to avoid conflicting filters
    if (tagId !== null) {
      setActiveFolderId(null);
    }
  }

  async function handleAddFolder() {
    const result = await ipc.client.shell.openFolderDialog({});
    const folderPath = result?.path;
    if (!folderPath) {
      return;
    }

    setScanningFolder(folderPath);
    setScanProgress(t("scanningProgress", { scanned: 0, total: 0 }));
    try {
      const scanResult = await ipc.client.photos.scanFolder({
        path: folderPath,
      });
      const skipped = scanResult.skipped || 0;
      setScanProgress(
        skipped > 0
          ? t("scanningSkipped", {
              count: scanResult.photoIds?.length || 0,
              skipped,
            })
          : t("scanningComplete", {
              count: scanResult.photoIds?.length || 0,
            })
      );
      await loadFolders();
      await loadPhotos();
    } catch {
      setScanProgress("");
    } finally {
      setScanningFolder(null);
      setTimeout(() => setScanProgress(""), 3000);
    }
  }

  async function handleDeleteFolder(id: number) {
    await ipc.client.photos.deleteFolder({ id });
    if (activeFolderId === id) {
      setActiveFolderId(null);
    }
    await loadFolders();
    await loadPhotos();
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
      loadPhotos();
      return;
    }

    const startTime = performance.now();
    setSearchMode(query.trim() ? "text" : "exif");

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
        // Parse as local date at start of day
        const [y, m, d] = filters.dateFrom.split("-").map(Number);
        searchParams.dateFrom = new Date(y, m - 1, d, 0, 0, 0).getTime();
      }
      if (filters?.dateTo) {
        // Parse as local date at end of day
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

      const result = await ipc.client.photos.searchCompound(
        searchParams
      );
      setPhotos((result as any).results || []);
      setTotalPhotos((result as any).total || (result as any).results?.length || 0);
      setSearchTime(Math.round(performance.now() - startTime));
    } catch {
      const fallback = await ipc.client.photos.listPhotos({
        search: query.trim() || undefined,
        sort: "date",
        order: "desc",
        offset: 0,
        limit: 500,
      });
      setPhotos((fallback as any).items || []);
      setTotalPhotos((fallback as any).total || 0);
      setSearchTime(Math.round(performance.now() - startTime));
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

  async function handleDeletePhoto(id: number) {
    await ipc.client.photos.deletePhoto({ id });
    setPhotos((prev) => prev.filter((p) => p.id !== id));
    setSelectedIds((prev) => {
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
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

  async function handleDeleteSelected() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) {
      return;
    }
    await ipc.client.photos.deletePhotos({ ids });
    setPhotos((prev) => prev.filter((p) => !selectedIds.has(p.id)));
    setSelectedIds(new Set());
  }

  async function handleRenameSelected(pattern: string) {
    const ids = Array.from(selectedIds);
    const result = await ipc.client.photos.renamePhotos({
      ids,
      pattern,
    });
    // Reload photos to reflect new names
    loadPhotos();
    return result as { renamed: number; errors: number; results: Array<{ id: number; oldName: string; newName: string; error?: string }> };
  }

  async function handleConvertSelected(options: {
    format: "jpg" | "png" | "webp" | "avif";
    quality: number;
    maxWidth: number;
    outputDir: string;
  }) {
    const ids = Array.from(selectedIds);
    const result = await ipc.client.photos.convertPhotos({
      ids,
      format: options.format,
      quality: options.quality,
      maxWidth: options.maxWidth || undefined,
      outputDir: options.outputDir,
    });
    return result as { converted: number; outputDir: string };
  }

  async function handleImageSearch(imagePath: string) {
    setSearchQuery("[以图搜图]");
    setSearchMode("image");
    setLoading(true);
    const startTime = performance.now();
    try {
      const result = await ipc.client.photos.searchByImage({
        imagePath,
        limit: 100,
      });
      if (result.error) console.warn("[ImageSearch]", result.error);
      const results = (result as any).results || [];
      setPhotos(results);
      setTotalPhotos(results.length);
      setSearchTime(Math.round(performance.now() - startTime));
    } catch (err: any) {
      console.error("[ImageSearch] failed:", err?.message || err);
      setPhotos([]);
      setTotalPhotos(0);
      setSearchTime(Math.round(performance.now() - startTime));
    } finally {
      setLoading(false);
    }
  }

  // Keyboard shortcuts for batch operations
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Don't intercept when typing in inputs
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        return;
      }

      // Ctrl+A: Select all visible photos
      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        setSelectedIds(new Set(photos.map((p) => p.id)));
        return;
      }

      // Delete: Delete selected photos
      if (e.key === "Delete" && selectedIds.size > 0) {
        e.preventDefault();
        handleDeleteSelected();
        return;
      }

      // F2: Rename selected photos
      if (e.key === "F2" && selectedIds.size > 0) {
        e.preventDefault();
        setRenameDialogOpen(true);
        return;
      }

      // Ctrl+Shift+E: Export selected
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "E") {
        e.preventDefault();
        if (selectedIds.size > 0) {
          handleExportSelected();
        }
        return;
      }

      // Ctrl+Shift+C: Convert selected
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "C") {
        e.preventDefault();
        if (selectedIds.size > 0) {
          setConvertDialogOpen(true);
        }
        return;
      }

      // Escape: Clear selection and close dialogs
      if (e.key === "Escape") {
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
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [photos, selectedIds, renameDialogOpen, convertDialogOpen]);

  const hasPhotos = photos.length > 0 || (loading && photos.length === 0);

  return (
    <div className="flex h-full">
      <Sidebar
        activeFolderId={activeFolderId}
        collapsed={sidebarCollapsed}
        folders={folders}
        onAddFolder={handleAddFolder}
        onDeleteFolder={handleDeleteFolder}
        onSelectFolder={setActiveFolderId}
        onSelectTag={handleSelectTag}
        onToggleCollapse={toggleSidebar}
        scanningFolder={scanningFolder}
        scanProgress={scanProgress}
        totalPhotos={totalPhotos}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <SearchBar
          aiStatus={aiStatus}
          imageSearchActive={searchQuery.startsWith("[以图搜图]")}
          onClear={() => {
            setSearchQuery("");
            setSearchMode(null);
            setSearchTime(undefined);
            loadPhotos();
          }}
          onImageSearch={handleImageSearch}
          onSearch={handleSearch}
          resultCount={searchQuery ? photos.length : undefined}
          searchMode={searchMode}
          searchTime={searchTime}
        />
        {hasPhotos ? (
          <div className="flex min-h-0 flex-1">
            <PhotoGrid
              loading={loading}
              onContextMenu={handleContextMenu}
              onConvertSelected={
                selectedIds.size > 0
                  ? () => setConvertDialogOpen(true)
                  : undefined
              }
              onDeleteSelected={handleDeleteSelected}
              onDoubleClick={handleDoubleClick}
              onExportSelected={handleExportSelected}
              onRenameSelected={
                selectedIds.size > 0
                  ? () => setRenameDialogOpen(true)
                  : undefined
              }
              onSelect={handleSelect}
              photos={photos}
              searchQuery={searchQuery}
              selectedIds={selectedIds}
            />
            {detailPhoto && (
              <PhotoDetailPanel
                onClose={() => {
                  setDetailPhoto(null);
                  setSelectedIds(new Set());
                }}
                onOpenExplorer={handleOpenExplorer}
                photo={detailPhoto}
              />
            )}
          </div>
        ) : (
          <Welcome onAddFolder={handleAddFolder} />
        )}
      </div>
      {lightboxIndex >= 0 && (
        <PhotoLightbox
          index={lightboxIndex}
          onClose={() => setLightboxIndex(-1)}
          open={lightboxIndex >= 0}
          photos={photos}
        />
      )}
      <PhotoContextMenu
        menu={ctxMenu}
        onAddToAlbum={handleAddToAlbum}
        onClose={() => setCtxMenu((prev) => ({ ...prev, open: false }))}
        onDelete={handleDeletePhoto}
        onExport={handleExportPhoto}
        onOpenExplorer={handleOpenExplorer}
      />
      <BatchRenameDialog
        onClose={() => {
          setRenameDialogOpen(false);
          setSelectedIds(new Set());
        }}
        onRename={handleRenameSelected}
        open={renameDialogOpen}
        photoCount={selectedIds.size}
        sampleFilename={photos[0]?.filename ?? "photo.jpg"}
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
    </div>
  );
}

export const Route = createFileRoute("/")({ component: HomePage });
