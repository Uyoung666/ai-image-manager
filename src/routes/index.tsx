import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MenuState } from "@/components/PhotoContextMenu";
import { PhotoContextMenu } from "@/components/PhotoContextMenu";
import { PhotoDetailPanel } from "@/components/PhotoDetailPanel";
import { PhotoGrid } from "@/components/PhotoGrid";
import { PhotoLightbox } from "@/components/PhotoLightbox";
import type { ExifFilters } from "@/components/SearchBar";
import { SearchBar } from "@/components/SearchBar";
import { Sidebar } from "@/components/Sidebar";
import { Welcome } from "@/components/Welcome";
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
  const [scanningFolder, setScanningFolder] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
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
    [activeFolderId]
  );

  useEffect(() => {
    loadFolders();
    loadPhotos(true);
  }, [loadPhotos, loadFolders]);

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

  async function handleAddFolder() {
    const result = await ipc.client.shell.openFolderDialog({});
    const folderPath = (result as any)?.path;
    if (!folderPath) {
      return;
    }

    setScanningFolder(folderPath);
    setScanProgress(t("scanningProgress", { scanned: 0, total: 0 }));
    try {
      const scanResult = await ipc.client.photos.scanFolder({
        path: folderPath,
      });
      setScanProgress(
        t("scanningComplete", {
          count: (scanResult as any).photoIds?.length || 0,
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
      loadPhotos();
      return;
    }

    try {
      const searchParams: Record<string, unknown> = { limit: 100 };
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
        searchParams as any
      );
      const data = result as any;
      setPhotos(data.results || []);
      setTotalPhotos(data.total || data.results?.length || 0);
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

  async function handleExportPhoto(id: number) {
    await doExport([id]);
  }

  async function handleExportSelected() {
    await doExport(Array.from(selectedIds));
  }

  async function doExport(ids: number[]) {
    if (ids.length === 0) {
      return;
    }
    try {
      const defaultName = `gallery-${new Date().toISOString().slice(0, 10)}.zip`;
      const dialogResult = await ipc.client.shell.saveFileDialog({
        defaultName,
        title: "导出照片画廊",
      });
      const savePath = (dialogResult as any)?.path;
      if (!savePath) {
        return;
      }
      const result = await ipc.client.photos.exportPhotos({
        ids,
        format: "original",
        outputPath: savePath,
      });
      if ((result as any).success) {
        await ipc.client.shell.openInExplorer({ path: savePath });
      }
    } catch {
      /* ignore */
    }
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

  async function handleImageSearch(imagePath: string) {
    setSearchQuery("[以图搜图]");
    try {
      const result = await ipc.client.photos.searchByImage({
        imagePath,
        limit: 100,
      });
      setPhotos((result as any).results || []);
    } catch {
      /* ignore */
    }
  }

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
        onToggleCollapse={toggleSidebar}
        scanningFolder={scanningFolder}
        scanProgress={scanProgress}
        totalPhotos={totalPhotos}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <SearchBar
          onClear={() => {
            setSearchQuery("");
            loadPhotos();
          }}
          onImageSearch={handleImageSearch}
          onSearch={handleSearch}
        />
        {hasPhotos ? (
          <div className="flex min-h-0 flex-1">
            <PhotoGrid
              loading={loading}
              onContextMenu={handleContextMenu}
              onDeleteSelected={handleDeleteSelected}
              onDoubleClick={handleDoubleClick}
              onExportSelected={handleExportSelected}
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
        onClose={() => setCtxMenu((prev) => ({ ...prev, open: false }))}
        onDelete={handleDeletePhoto}
        onExport={handleExportPhoto}
        onOpenExplorer={handleOpenExplorer}
      />
    </div>
  );
}

export const Route = createFileRoute("/")({ component: HomePage });
