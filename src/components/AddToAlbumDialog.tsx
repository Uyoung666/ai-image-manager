import { Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ipc } from "@/ipc/manager";

interface AlbumInfo {
  description: string | null;
  id: number;
  isSmart?: boolean;
  name: string;
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
  const { t } = useTranslation();
  const [albums, setAlbums] = useState<AlbumInfo[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState<Set<number>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);

  const loadAlbums = useCallback(async () => {
    try {
      const result = await ipc.client.albums.listAlbums({});
      setAlbums((result as AlbumInfo[]).filter((a) => !a.isSmart));
    } catch (err) {
      console.error("[AddToAlbumDialog loadAlbums] failed:", err);
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

  async function handleAdd(albumId: number) {
    const album = albums.find((a) => a.id === albumId);
    setAdding((prev) => new Set(prev).add(albumId));
    try {
      await ipc.client.albums.addPhotosToAlbum({ albumId, photoIds });
      toast.success(
        t("toastAddToAlbumSuccess", {
          count: photoIds.length,
          album: album?.name || "",
        })
      );
    } catch {
      toast.error(t("toastAddFailed"));
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
    if (!name) {
      return;
    }
    try {
      const created = await ipc.client.albums.createAlbum({ name });
      const album = created as AlbumInfo;
      await ipc.client.albums.addPhotosToAlbum({
        albumId: album.id,
        photoIds,
      });
      onClose();
    } catch {
      toast.error(t("albumCreateFailed"));
    }
  }

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      open={open}
    >
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t("albumAddTitle")}</DialogTitle>
        </DialogHeader>

        <div className="-mx-1 max-h-[300px] overflow-y-auto">
          {albums.length === 0 && !showCreate ? (
            <p className="px-3 py-6 text-center text-[13px] text-muted-foreground/70">
              {t("albumNoAlbumsCreate")}
            </p>
          ) : (
            albums.map((album) => (
              <button
                className="flex w-full items-center gap-3 rounded-[6px] px-3 py-2 text-left text-[13px] text-foreground transition-colors hover:bg-foreground/5 disabled:opacity-50"
                disabled={adding.has(album.id)}
                key={album.id}
                onClick={() => handleAdd(album.id)}
                type="button"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-[6px] bg-white/5 text-muted-foreground">
                  <svg
                    aria-hidden="true"
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

          {showCreate ? (
            <div className="flex items-center gap-2 px-3 py-2">
              <input
                className="h-8 flex-1 rounded-[6px] border border-input bg-card px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary"
                onChange={(e) => setNewName(e.target.value)}
                onCompositionEnd={(e) => {
                  composingRef.current = false;
                  setNewName((e.target as HTMLInputElement).value);
                }}
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                onKeyDown={(e) => {
                  if (composingRef.current) {
                    return;
                  }
                  if (e.key === "Enter") {
                    handleCreateAndAdd();
                  }
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setShowCreate(false);
                    setNewName("");
                  }
                }}
                placeholder={t("albumNamePlaceholder")}
                ref={inputRef}
                value={newName}
              />
              <button
                className="flex h-8 items-center gap-1 rounded-[6px] bg-primary px-3 text-[13px] text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
                disabled={!newName.trim()}
                onClick={handleCreateAndAdd}
                type="button"
              >
                {t("albumCreate")}
              </button>
            </div>
          ) : (
            <button
              className="flex w-full items-center gap-2 rounded-[6px] px-3 py-2 text-[13px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
              onClick={() => setShowCreate(true)}
              type="button"
            >
              <Plus className="h-4 w-4" />
              {t("albumNew")}
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
