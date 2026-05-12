import { createFileRoute, Link, Outlet, useMatch, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Sparkles, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { SmartAlbumDialog } from "@/components/SmartAlbumDialog";
import { ipc } from "@/ipc/manager";

interface AlbumInfo {
  id: number;
  name: string;
  description: string | null;
  coverPhotoId: number | null;
  isSmart: boolean;
  createdAt: number;
}

interface PhotoInfo {
  id: number;
  filename: string;
  thumbnailPath: string | null;
}

function AlbumsPage() {
  const [albums, setAlbums] = useState<AlbumInfo[]>([]);
  const [covers, setCovers] = useState<Map<number, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [creating, setCreating] = useState(false);
  const [showSmartDialog, setShowSmartDialog] = useState(false);
  const navigate = useNavigate();

  const loadAlbums = useCallback(async () => {
    try {
      const result = await ipc.client.albums.listAlbums({});
      const list = result as AlbumInfo[];
      setAlbums(list);

      // Load cover thumbnails
      const coverPhotoIds = list
        .filter((a) => a.coverPhotoId)
        .map((a) => a.coverPhotoId!);
      if (coverPhotoIds.length > 0) {
        const photoResults = await Promise.all(
          coverPhotoIds.map((id) =>
            ipc.client.photos.getPhotoDetail({ id }).catch(() => null)
          )
        );
        const coverMap = new Map<number, string>();
        photoResults.forEach((p: any) => {
          if (p?.id && p?.thumbnailPath) {
            coverMap.set(p.id, p.thumbnailPath);
          }
        });
        setCovers(coverMap);
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAlbums();
  }, [loadAlbums]);

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      await ipc.client.albums.createAlbum({
        name,
        description: newDesc.trim() || undefined,
      });
      setNewName("");
      setNewDesc("");
      setShowCreate(false);
      loadAlbums();
    } catch {
      /* ignore */
    }
    setCreating(false);
  }

  function toLocalMediaUrl(filePath: string): string {
    const encoded = filePath
      .replace(/\\/g, "/")
      .split("/")
      .map((s) => encodeURIComponent(s))
      .join("/");
    return `local-media://${encoded}`;
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between border-border border-b px-6 py-4">
        <div className="flex items-center gap-3">
          <button
            className="flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            onClick={() => navigate({ to: "/" })}
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <h1 className="font-[590] text-[24px] text-foreground tracking-tight">
              相册
            </h1>
            <p className="mt-0.5 text-[#6b6b75] text-[12px]">
              {albums.length} 个相册
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            className="flex items-center gap-1.5 rounded-[6px] border border-primary/40 px-4 py-1.5 text-[13px] font-[510] text-primary transition-colors hover:border-primary hover:bg-primary/5"
            onClick={() => setShowSmartDialog(true)}
          >
            <Sparkles className="h-3.5 w-3.5" />
            智能相册
          </button>
          <button
            className="rounded-[6px] bg-primary px-4 py-1.5 text-[13px] font-[510] text-white transition-opacity hover:opacity-90"
            onClick={() => setShowCreate(true)}
          >
            新建相册
          </button>
        </div>
      </div>

      {/* Create dialog inline */}
      {showCreate && (
        <div className="border-border border-b px-6 py-4">
          <div className="flex gap-3">
            <input
              autoFocus
              className="h-8 flex-1 rounded-[6px] border border-input bg-card px-3 text-[13px] text-foreground outline-none placeholder:text-[#6b6b75] focus:border-primary"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
                if (e.key === "Escape") setShowCreate(false);
              }}
              placeholder="相册名称"
              value={newName}
            />
            <input
              className="h-8 flex-1 rounded-[6px] border border-input bg-card px-3 text-[13px] text-foreground outline-none placeholder:text-[#6b6b75] focus:border-primary"
              onChange={(e) => setNewDesc(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
                if (e.key === "Escape") setShowCreate(false);
              }}
              placeholder="描述 (可选)"
              value={newDesc}
            />
            <button
              className="rounded-[6px] bg-primary px-4 py-1.5 text-[13px] font-[510] text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              disabled={!newName.trim() || creating}
              onClick={handleCreate}
            >
              创建
            </button>
            <button
              className="rounded-[6px] border border-input px-4 py-1.5 text-[13px] text-muted-foreground transition-colors hover:border-muted-foreground hover:text-foreground"
              onClick={() => setShowCreate(false)}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                className="aspect-[4/3] animate-pulse rounded-[8px] bg-card"
                key={i}
              />
            ))}
          </div>
        ) : albums.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center gap-3 text-[#6b6b75]">
            <svg
              fill="none"
              height="48"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1"
              viewBox="0 0 24 24"
              width="48"
            >
              <rect height="18" rx="2" ry="2" width="18" x="3" y="3" />
              <path d="M3 9h18" />
              <path d="M9 21V9" />
            </svg>
            <p className="text-[13px]">还没有相册</p>
            <button
              className="rounded-[6px] bg-primary px-4 py-1.5 text-[13px] font-[510] text-white transition-opacity hover:opacity-90"
              onClick={() => setShowCreate(true)}
            >
              创建第一个相册
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
            {albums.map((album) => (
              <Link
                className={`group overflow-hidden rounded-[8px] bg-card transition-colors hover:border-primary/30 ${
                  album.isSmart
                    ? "border border-primary/20"
                    : "border border-border"
                }`}
                key={album.id}
                to="/albums/$albumId"
                params={{ albumId: album.id.toString() }}
              >
                <div className="aspect-[4/3] bg-muted">
                  {album.coverPhotoId && covers.has(album.coverPhotoId) ? (
                    <img
                      alt={album.name}
                      className="h-full w-full object-cover"
                      src={toLocalMediaUrl(covers.get(album.coverPhotoId)!)}
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                      {album.isSmart ? (
                        <Zap className="h-8 w-8 text-muted-foreground/20" />
                      ) : (
                        <svg
                          fill="none"
                          height="32"
                          stroke="currentColor"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="1"
                          viewBox="0 0 24 24"
                          width="32"
                        >
                          <rect height="18" rx="2" ry="2" width="18" x="3" y="3" />
                          <path d="M3 9h18" />
                          <path d="M9 21V9" />
                        </svg>
                      )}
                    </div>
                  )}
                </div>
                <div className="p-3">
                  <div className="flex items-center gap-1.5">
                    {album.isSmart && (
                      <Zap className="h-3 w-3 text-primary" />
                    )}
                    <h3 className="truncate font-[510] text-[14px] text-foreground">
                      {album.name}
                    </h3>
                  </div>
                  {album.description && (
                    <p className="mt-0.5 truncate text-[#6b6b75] text-[11px]">
                      {album.description}
                    </p>
                  )}
                  <p className="mt-1 text-[#6b6b75] text-[10px]">
                    {album.isSmart ? "智能相册" : new Date(album.createdAt).toLocaleDateString("zh-CN")}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      <SmartAlbumDialog
        onClose={() => setShowSmartDialog(false)}
        onCreated={loadAlbums}
        open={showSmartDialog}
      />
    </div>
  );
}

function AlbumsLayout() {
  const childMatch = useMatch({ from: "/albums/$albumId", shouldThrow: false });
  if (childMatch) {
    return <Outlet />;
  }
  return <AlbumsPage />;
}

export const Route = createFileRoute("/albums" as any)({ component: AlbumsLayout });
