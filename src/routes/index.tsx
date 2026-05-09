import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/ipc/manager";
import { PhotoGrid } from "@/components/PhotoGrid";
import { Sidebar } from "@/components/Sidebar";
import { SearchBar } from "@/components/SearchBar";
import { Welcome } from "@/components/Welcome";

interface Photo {
  id: number; path: string; filename: string;
  width: number; height: number; fileSize: number;
  thumbnailPath: string; isIndexed: boolean;
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
  const [loadingMore, setLoadingMore] = useState(false);

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
    setLoading(true);
    try {
      const result = await ipc.client.photos.listPhotos({
        folderId: activeFolderId || undefined,
        sort: "date", order: "desc", offset: 0, limit: 500,
      });
      setPhotos((result as any).items || []);
    } catch { /* ignore */ }
    finally { setLoading(false); }
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

  async function handleAIIndex() {
    setScanProgress(t("aiIndexingStarted"));
    try {
      const result = await ipc.client.photos.startAiIndexing({});
      setScanProgress(t("aiIndexedCount", { count: (result as any).embedded || 0 }));
      setTimeout(() => setScanProgress(""), 3000);
    } catch { setScanProgress(""); }
  }

  const handleSelect = useCallback((id: number, event: React.MouseEvent) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (event.ctrlKey || event.metaKey) {
        next.has(id) ? next.delete(id) : next.add(id);
      } else {
        next.clear(); next.add(id);
      }
      return next;
    });
  }, []);

  const handleDoubleClick = useCallback((id: number) => {
    console.log("Open detail for photo:", id);
  }, []);

  async function handleSearch(query: string) {
    if (!query.trim()) { loadPhotos(); return; }
    setLoading(true);
    try {
      const result = await ipc.client.photos.searchByText({ query, limit: 100 });
      setPhotos((result as any).results || []);
    } catch {
      const fallback = await ipc.client.photos.listPhotos({
        search: query, sort: "date", order: "desc", offset: 0, limit: 500,
      });
      setPhotos((fallback as any).items || []);
    } finally { setLoading(false); }
  }

  const hasPhotos = photos.length > 0 || loading;

  return (
    <div className="flex h-full">
      <Sidebar
        folders={folders}
        activeFolderId={activeFolderId}
        onSelectFolder={setActiveFolderId}
        onAddFolder={handleAddFolder}
        onAIIndex={handleAIIndex}
        scanningFolder={scanningFolder}
        scanProgress={scanProgress}
        totalPhotos={photos.length}
      />
      <div className="flex-1 flex flex-col min-w-0">
        <SearchBar onSearch={handleSearch} onClear={() => loadPhotos()} />
        {hasPhotos ? (
          <PhotoGrid
            photos={photos}
            loading={loading}
            selectedIds={selectedIds}
            onSelect={handleSelect}
            onDoubleClick={handleDoubleClick}
          />
        ) : (
          <Welcome
            onAddFolder={handleAddFolder}
            onAIIndex={handleAIIndex}
            hasPhotos={false}
          />
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/")({ component: HomePage });
