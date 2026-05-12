import { Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "@/ipc/manager";

interface AlbumInfo {
  id: number;
  name: string;
  description: string | null;
  photoCount?: number;
}

interface AddToAlbumDialogProps {
  onClose: () => void;
  open: boolean;
  photoIds: number[];
}

export function AddToAlbumDialog({
  open,
  onClose,
  photoIds,
}: AddToAlbumDialogProps) {
  const [albums, setAlbums] = useState<AlbumInfo[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState<Set<number>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const loadAlbums = useCallback(async () => {
    try {
      const result = await ipc.client.albums.listAlbums({});
      setAlbums(result as AlbumInfo[]);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (open) {
      loadAlbums();
      setShowCreate(false);
      setNewName("");
      setAdding(new Set());
    }
  }, [open, loadAlbums]);

  useEffect(() => {
    if (showCreate && inputRef.current) {
      inputRef.current.focus();
    }
  }, [showCreate]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    if (open) {
      document.addEventListener("keydown", handleKey);
      return () => document.removeEventListener("keydown", handleKey);
    }
  }, [open, onClose]);

  async function handleAdd(albumId: number) {
    setAdding((prev) => new Set(prev).add(albumId));
    try {
      await ipc.client.albums.addPhotosToAlbum({ albumId, photoIds });
    } catch {
      /* ignore */
    }
    setAdding((prev) => {
      const next = new Set(prev);
      next.delete(albumId);
      return next;
    });
    onClose();
  }

  async function handleCreateAndAdd() {
    const name = newName.trim();
    if (!name) return;
    try {
      const created = await ipc.client.albums.createAlbum({ name });
      const album = created as AlbumInfo;
      await ipc.client.albums.addPhotosToAlbum({
        albumId: album.id,
        photoIds,
      });
      onClose();
    } catch {
      /* ignore */
    }
  }

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) onClose();
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={handleOverlayClick}
      ref={overlayRef}
    >
      <div className="w-[360px] rounded-[12px] border border-border bg-popover ring-1 ring-white/5">
        {/* Header */}
        <div className="flex items-center justify-between border-border border-b px-5 py-4">
          <h2 className="font-[590] text-[16px] text-foreground">
            添加到相册
          </h2>
          <button
            className="flex h-6 w-6 items-center justify-center rounded-[4px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Album list */}
        <div className="max-h-[300px] overflow-y-auto p-2">
          {albums.length === 0 && !showCreate ? (
            <p className="px-3 py-6 text-center text-[#6b6b75] text-[13px]">
              还没有相册，创建一个吧
            </p>
          ) : (
            albums.map((album) => (
              <button
                className="flex w-full items-center gap-3 rounded-[6px] px-3 py-2 text-left text-[13px] text-foreground transition-colors hover:bg-foreground/5"
                disabled={adding.has(album.id)}
                key={album.id}
                onClick={() => handleAdd(album.id)}
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-[6px] bg-white/5 text-muted-foreground">
                  <svg
                    fill="none"
                    height="16"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.5"
                    viewBox="0 0 24 24"
                    width="16"
                  >
                    <rect height="18" rx="2" ry="2" width="18" x="3" y="3" />
                    <path d="M3 9h18" />
                    <path d="M9 21V9" />
                  </svg>
                </div>
                <span className="flex-1 truncate">{album.name}</span>
                {adding.has(album.id) && (
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                )}
              </button>
            ))
          )}

          {/* Create new album */}
          {showCreate ? (
            <div className="flex items-center gap-2 px-3 py-2">
              <input
                className="h-8 flex-1 rounded-[6px] border border-input bg-card px-3 text-[13px] text-foreground outline-none placeholder:text-[#6b6b75] focus:border-primary"
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateAndAdd();
                  if (e.key === "Escape") {
                    setShowCreate(false);
                    setNewName("");
                  }
                }}
                placeholder="相册名称..."
                ref={inputRef}
                value={newName}
              />
              <button
                className="flex h-8 items-center gap-1 rounded-[6px] bg-primary px-3 text-[13px] text-white hover:opacity-90 disabled:opacity-40"
                disabled={!newName.trim()}
                onClick={handleCreateAndAdd}
              >
                创建
              </button>
            </div>
          ) : (
            <button
              className="flex w-full items-center gap-2 rounded-[6px] px-3 py-2 text-[13px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
              onClick={() => setShowCreate(true)}
            >
              <Plus className="h-4 w-4" />
              新建相册
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
