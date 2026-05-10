import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/ipc/manager";
import { PhotoGrid } from "@/components/PhotoGrid";
import { PhotoLightbox } from "@/components/PhotoLightbox";
import { PhotoContextMenu } from "@/components/PhotoContextMenu";
import type { MenuState } from "@/components/PhotoContextMenu";
import { Sidebar } from "@/components/Sidebar";
import { SearchBar } from "@/components/SearchBar";
import { Welcome } from "@/components/Welcome";

interface Photo {
  id: number; path: string; filename: string;
  width: number; height: number; fileSize: number;
  thumbnailPath: string | null; isIndexed: boolean;
}
interface Folder {
  id: number; path: string; displayName: string; photoCount: number;
}

function HomePage() {
  const { t } = useTranslation();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [activeFolderId, setActiveFolderId] = useState<number | null>(null);
  const [scanningFolder, setScanningFolder] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [lightboxIndex, setLightboxIndex] = useState(-1);
  const [lastClickedIdx, setLastClickedIdx] = useState(-1);
  const [ctxMenu, setCtxMenu] = useState<MenuState>({ open: false, x: 0, y: 0, photoId: null, photoPath: null });

  useEffect(() => {
    loadFolders();
    loadPhotos();
  }, [activeFolderId]);

  async function loadFolders() {
    try {
      const result = await ipc.client.photos.getFolders({});
      setFolders(result as Folder[]);
    } catch { /* ignore */ }
  }

  async function loadPhotos() {
    const isFirstLoad = photos.length === 0;
    if (isFirstLoad) setLoading(true);
    try {
      const result = await ipc.client.photos.listPhotos({
        folderId: activeFolderId || undefined,
        sort: "date", order: "desc", offset: 0, limit: 500,
      });
      setPhotos((result as any).items || []);
    } catch { /* ignore */ }
    finally { if (isFirstLoad) setLoading(false); }
  }

  async function handleAddFolder() {
    const result = await ipc.client.shell.openFolderDialog({});
    const folderPath = (result as any)?.path;
    if (!folderPath) return;

    setScanningFolder(folderPath);
    setScanProgress(t("scanningProgress", { scanned: 0, total: 0 }));
    try {
      const scanResult = await ipc.client.photos.scanFolder({ path: folderPath });
      setScanProgress(t("scanningComplete", { count: (scanResult as any).photoIds?.length || 0 }));
      await loadFolders();
      await loadPhotos();
    } catch {
      setScanProgress("");
    } finally {
      setScanningFolder(null);
      setTimeout(() => setScanProgress(""), 3000);
    }
  }

  const handleSelect = useCallback((id: number, event: React.MouseEvent) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      const idx = photos.findIndex(p => p.id === id);
      if (event.shiftKey && lastClickedIdx >= 0 && idx >= 0) {
        const [from, to] = lastClickedIdx < idx ? [lastClickedIdx, idx] : [idx, lastClickedIdx];
        for (let i = from; i <= to; i++) next.add(photos[i].id);
      } else if (event.ctrlKey || event.metaKey) {
        next.has(id) ? next.delete(id) : next.add(id);
        if (idx >= 0) setLastClickedIdx(idx);
      } else {
        next.clear(); next.add(id);
        if (idx >= 0) setLastClickedIdx(idx);
      }
      return next;
    });
  }, [photos, lastClickedIdx]);

  const handleDoubleClick = useCallback((id: number) => {
    const idx = photos.findIndex(p => p.id === id);
    if (idx >= 0) setLightboxIndex(idx);
  }, [photos]);

  async function handleSearch(query: string) {
    setSearchQuery(query);
    if (!query.trim()) { loadPhotos(); return; }
    try {
      const result = await ipc.client.photos.searchByText({ query, limit: 100 });
      setPhotos((result as any).results || []);
    } catch {
      const fallback = await ipc.client.photos.listPhotos({
        search: query, sort: "date", order: "desc", offset: 0, limit: 500,
      });
      setPhotos((fallback as any).items || []);
    }
  }

  function handleContextMenu(e: React.MouseEvent) {
    const card = (e.target as HTMLElement).closest("[data-photo-id]") as HTMLElement | null;
    if (!card) return;
    const id = parseInt(card.dataset.photoId || "", 10);
    const path = card.dataset.photoPath || null;
    if (!id) return;
    e.preventDefault();
    setCtxMenu({ open: true, x: e.clientX, y: e.clientY, photoId: id, photoPath: path });
  }

  async function handleOpenExplorer(filePath: string) {
    await ipc.client.shell.openInExplorer({ path: filePath });
  }

  async function handleDeletePhoto(id: number) {
    await ipc.client.photos.deletePhoto({ id });
    setPhotos(prev => prev.filter(p => p.id !== id));
    setSelectedIds(prev => { const n = new Set(prev); n.delete(id); return n; });
  }

  async function handleDeleteSelected() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    await ipc.client.photos.deletePhotos({ ids });
    setPhotos(prev => prev.filter(p => !selectedIds.has(p.id)));
    setSelectedIds(new Set());
  }

  async function handleImageSearch(imagePath: string) {
    setSearchQuery("[以图搜图]");
    try {
      const result = await ipc.client.photos.searchByImage({ imagePath, limit: 100 });
      setPhotos((result as any).results || []);
    } catch { /* ignore */ }
  }

  const hasPhotos = photos.length > 0 || (loading && photos.length === 0);

  return (
    <div className="flex h-full">
      <Sidebar
        folders={folders}
        activeFolderId={activeFolderId}
        onSelectFolder={setActiveFolderId}
        onAddFolder={handleAddFolder}
        scanningFolder={scanningFolder}
        scanProgress={scanProgress}
        totalPhotos={photos.length}
      />
      <div className="flex-1 flex flex-col min-w-0">
        <SearchBar onSearch={handleSearch} onClear={() => { setSearchQuery(""); loadPhotos(); }} onImageSearch={handleImageSearch} />
        {hasPhotos ? (
          <PhotoGrid
            photos={photos}
            loading={loading}
            selectedIds={selectedIds}
            onSelect={handleSelect}
            onDoubleClick={handleDoubleClick}
            searchQuery={searchQuery}
            onContextMenu={handleContextMenu}
            onDeleteSelected={handleDeleteSelected}
          />
        ) : (
          <Welcome
            onAddFolder={handleAddFolder}
            onAIIndex={() => {}}
            hasPhotos={false}
          />
        )}
      </div>
      {lightboxIndex >= 0 && (
        <PhotoLightbox
          photos={photos}
          index={lightboxIndex}
          open={lightboxIndex >= 0}
          onClose={() => setLightboxIndex(-1)}
        />
      )}
      <PhotoContextMenu
        menu={ctxMenu}
        onOpenExplorer={handleOpenExplorer}
        onDelete={handleDeletePhoto}
        onClose={() => setCtxMenu(prev => ({ ...prev, open: false }))}
      />
    </div>
  );
}

export const Route = createFileRoute("/")({ component: HomePage });
