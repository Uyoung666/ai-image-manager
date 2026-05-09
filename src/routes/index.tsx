import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/ipc/manager";
import { PhotoGrid } from "@/components/PhotoGrid";
import { Sidebar } from "@/components/Sidebar";
import { SearchBar } from "@/components/SearchBar";

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
  const navigate = useNavigate();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [activeFolderId, setActiveFolderId] = useState<number | null>(null);
  const [scanningFolder, setScanningFolder] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState("");

  useEffect(() => {
    loadFolders();
    loadPhotos();
  }, [activeFolderId]);

  async function loadFolders() {
    try {
      const result = await ipc.client.photos.getFolders({});
      setFolders(result as Folder[]);
    } catch (error) {
      console.error("Failed to load folders:", error);
    }
  }

  async function loadPhotos() {
    setLoading(true);
    try {
      const result = await ipc.client.photos.listPhotos({
        folderId: activeFolderId || undefined,
        sort: "date",
        order: "desc",
        offset: 0,
        limit: 500,
      });
      setPhotos((result as any).items || []);
    } catch (error) {
      console.error("Failed to load photos:", error);
    } finally {
      setLoading(false);
    }
  }

  async function handleAddFolder() {
    // Use Electron dialog or manual path input
    const folderPath = prompt("Enter folder path to index:");
    if (!folderPath) return;

    setScanningFolder(folderPath);
    setScanProgress("Scanning...");
    try {
      await ipc.client.photos.scanFolder({ path: folderPath });
      await loadFolders();
      await loadPhotos();
    } catch (error) {
      console.error("Failed to scan folder:", error);
    } finally {
      setScanningFolder(null);
      setScanProgress("");
    }
  }

  async function handleAIIndex() {
    setScanProgress("Starting AI indexing...");
    try {
      const result = await ipc.client.photos.startAiIndexing({});
      setScanProgress(`AI indexed ${(result as any).embedded} photos`);
      setTimeout(() => setScanProgress(""), 3000);
    } catch (error) {
      console.error("Failed to start AI indexing:", error);
      setScanProgress("");
    }
  }

  const handleSelect = useCallback((id: number, event: React.MouseEvent) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (event.ctrlKey || event.metaKey) {
        if (next.has(id)) next.delete(id); else next.add(id);
      } else {
        next.clear();
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleDoubleClick = useCallback((id: number) => {
    // Open detail panel or lightbox
    const photo = photos.find(p => p.id === id);
    if (photo) {
      navigate({ to: "/detail", search: { photoId: id } });
    }
  }, [photos, navigate]);

  async function handleSearch(query: string) {
    if (!query.trim()) {
      loadPhotos();
      return;
    }
    setLoading(true);
    try {
      const result = await ipc.client.photos.searchByText({ query, limit: 100 });
      setPhotos((result as any).results || []);
    } catch {
      // Fallback: local filename search
      const result = await ipc.client.photos.listPhotos({
        search: query,
        sort: "date",
        order: "desc",
        offset: 0,
        limit: 500,
      });
      setPhotos((result as any).items || []);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-full">
      {/* Sidebar */}
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

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Search bar */}
        <SearchBar onSearch={handleSearch} onClear={() => loadPhotos()} />

        {/* Photo Grid */}
        <PhotoGrid
          photos={photos}
          loading={loading}
          selectedIds={selectedIds}
          onSelect={handleSelect}
          onDoubleClick={handleDoubleClick}
        />
      </div>
    </div>
  );
}

export const Route = createFileRoute("/")({
  component: HomePage,
});
