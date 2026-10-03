import { Plus } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SmoothInput } from "@/components/ui/smooth-input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ipc } from "@/ipc/manager";
import { queryClient } from "@/providers/QueryProvider";

interface AlbumInfo {
  description: string | null;
  id: number;
  isSmart?: boolean;
  name: string;
  photoCount?: number;
}

interface AddToAlbumDialogProps {
  elevated?: boolean;
  onClose: () => void;
  open: boolean;
  photoIds: number[];
}

export function AddToAlbumDialog({
  elevated = false,
  open,
  onClose,
  photoIds,
}: AddToAlbumDialogProps) {
  const { t } = useTranslation();
  const [albums, setAlbums] = useState<AlbumInfo[]>([]);
  const [albumsLoading, setAlbumsLoading] = useState(false);
  const [albumsLoadError, setAlbumsLoadError] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [albumFilter, setAlbumFilter] = useState("");
  const [adding, setAdding] = useState<Set<number>>(new Set());
  const [creating, setCreating] = useState(false);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const filterComposingRef = useRef(false);
  const albumsRequestRef = useRef(0);

  const loadAlbums = useCallback(async () => {
    const requestId = ++albumsRequestRef.current;
    setAlbumsLoading(true);
    setAlbumsLoadError(false);
    try {
      const result = await ipc.client.albums.listAlbums({});
      if (requestId !== albumsRequestRef.current) {
        return;
      }
      setAlbums((result as AlbumInfo[]).filter((a) => !a.isSmart));
    } catch (err) {
      if (requestId !== albumsRequestRef.current) {
        return;
      }
      console.error("[AddToAlbumDialog loadAlbums] failed:", err);
      setAlbumsLoadError(true);
    } finally {
      if (requestId === albumsRequestRef.current) {
        setAlbumsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!open) {
      albumsRequestRef.current += 1;
      return;
    }
    loadAlbums();
    setShowCreate(false);
    setNewName("");
    setAlbumFilter("");
    setAdding(new Set());
    setCreating(false);
    const focusFrame = requestAnimationFrame(() => {
      filterInputRef.current?.focus();
    });
    return () => cancelAnimationFrame(focusFrame);
  }, [open, loadAlbums]);

  useEffect(() => {
    if (showCreate && inputRef.current) {
      inputRef.current.focus();
    }
  }, [showCreate]);

  async function handleAdd(albumId: number) {
    if (creating || adding.has(albumId)) {
      return;
    }
    const album = albums.find((a) => a.id === albumId);
    setAdding((prev) => new Set(prev).add(albumId));
    try {
      await ipc.client.albums.addPhotosToAlbum({ albumId, photoIds });
      queryClient.invalidateQueries({ queryKey: ["albums"] });
      toast.success(
        t("toastAddToAlbumSuccess", {
          count: photoIds.length,
          album: album?.name || "",
        })
      );
      onClose();
    } catch {
      toast.error(t("toastAddFailed"));
    } finally {
      setAdding((prev) => {
        const next = new Set(prev);
        next.delete(albumId);
        return next;
      });
    }
  }

  async function handleCreateAndAdd() {
    const name = newName.trim();
    if (!name || creating) {
      return;
    }
    setCreating(true);
    try {
      const created = await ipc.client.albums.createAlbum({ name });
      const album = created as AlbumInfo;
      try {
        await ipc.client.albums.addPhotosToAlbum({
          albumId: album.id,
          photoIds,
        });
      } catch {
        toast.error(t("toastAddFailed"));
        setShowCreate(false);
        setNewName("");
        await loadAlbums();
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["albums"] });
      toast.success(
        t("toastAddToAlbumSuccess", {
          count: photoIds.length,
          album: album.name || name,
        })
      );
      onClose();
    } catch {
      toast.error(t("albumCreateFailed"));
    } finally {
      setCreating(false);
    }
  }

  const busy = creating || adding.size > 0;
  const filteredAlbums = useMemo(() => {
    const query = albumFilter.trim().toLocaleLowerCase();
    if (!query) {
      return albums;
    }
    return albums.filter((album) =>
      album.name.toLocaleLowerCase().includes(query)
    );
  }, [albumFilter, albums]);
  let albumListContent: ReactNode;

  if (albumsLoading) {
    albumListContent = (
      <div className="flex items-center justify-center gap-2 px-3 py-6 text-[13px] text-muted-foreground">
        <LoadingSpinner size="sm" />
        <span>{t("loading")}</span>
      </div>
    );
  } else if (albumsLoadError) {
    albumListContent = (
      <div className="flex flex-col items-center gap-3 px-3 py-6 text-center text-[13px] text-muted-foreground">
        <p>{t("loadFailedRetry")}</p>
        <button
          className="rounded-[6px] border border-border px-3 py-1.5 text-foreground transition-colors hover:bg-foreground/5"
          disabled={busy}
          onClick={loadAlbums}
          type="button"
        >
          {t("retry")}
        </button>
      </div>
    );
  } else if (albums.length === 0 && !showCreate) {
    albumListContent = (
      <p className="px-3 py-6 text-center text-[13px] text-muted-foreground/70">
        {t("albumNoAlbumsCreate")}
      </p>
    );
  } else if (filteredAlbums.length === 0 && albumFilter.trim()) {
    albumListContent = (
      <p className="px-3 py-6 text-center text-[13px] text-muted-foreground/70">
        {t("albumFilterNoMatches")}
      </p>
    );
  } else {
    albumListContent = filteredAlbums.map((album) => (
      <Tooltip key={album.id}>
        <TooltipTrigger asChild>
          <button
            className="flex w-full items-center gap-3 rounded-[6px] px-3 py-2 text-left text-[13px] text-foreground transition-colors hover:bg-foreground/5 disabled:opacity-50"
            disabled={busy || adding.has(album.id)}
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
            <span className="min-w-0 flex-1 truncate">{album.name}</span>
            {adding.has(album.id) && <LoadingSpinner size="sm" />}
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-[min(28rem,calc(100vw-1rem))] break-all">
          {album.name}
        </TooltipContent>
      </Tooltip>
    ));
  }

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!(next || busy)) {
          onClose();
        }
      }}
      open={open}
    >
      <DialogContent
        className={`max-h-[calc(100dvh-1rem)] overflow-y-auto overflow-x-hidden ${
          elevated ? "z-[1101]" : ""
        }`}
        onEscapeKeyDown={(event) => {
          if (busy) {
            event.preventDefault();
            return;
          }
          if (event.target !== filterInputRef.current) {
            return;
          }
          if (filterComposingRef.current || event.isComposing) {
            event.preventDefault();
            return;
          }
          if (albumFilter.length > 0) {
            event.preventDefault();
            setAlbumFilter("");
            requestAnimationFrame(() => filterInputRef.current?.focus());
          }
        }}
        onPointerDownOutside={(event) => {
          if (busy) {
            event.preventDefault();
          }
        }}
        overlayClassName={elevated ? "z-[1100]" : undefined}
        showCloseButton={!busy}
        size="sm"
      >
        <DialogHeader>
          <DialogTitle>{t("albumAddTitle")}</DialogTitle>
          <DialogDescription>{t("albumAddDescription")}</DialogDescription>
        </DialogHeader>

        <div className="min-w-0">
          <SmoothInput
            aria-label={t("albumFilterLabel")}
            className="h-8 rounded-[6px] border border-input bg-card px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary"
            onChange={(event) => setAlbumFilter(event.target.value)}
            onCompositionEnd={(event) => {
              filterComposingRef.current = false;
              setAlbumFilter((event.target as HTMLInputElement).value);
            }}
            onCompositionStart={() => {
              filterComposingRef.current = true;
            }}
            onKeyDown={(event) => {
              if (filterComposingRef.current || event.nativeEvent.isComposing) {
                return;
              }
              if (event.key === "Escape" && albumFilter.length > 0) {
                event.preventDefault();
                event.stopPropagation();
                setAlbumFilter("");
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
              }
            }}
            placeholder={t("albumFilterPlaceholder")}
            ref={filterInputRef}
            type="text"
            value={albumFilter}
            wrapperClassName="w-full min-w-0"
          />
        </div>

        <div className="-mx-1 max-h-[min(18.75rem,50dvh)] overflow-y-auto overscroll-contain">
          {albumListContent}

          {showCreate ? (
            <div className="flex flex-wrap items-center gap-2 px-3 py-2">
              <SmoothInput
                className="h-8 rounded-[6px] border border-input bg-card px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary"
                disabled={creating}
                onChange={(e) => setNewName(e.target.value)}
                onCompositionEnd={(e) => {
                  composingRef.current = false;
                  setNewName((e.target as HTMLInputElement).value);
                }}
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                onKeyDown={(e) => {
                  if (composingRef.current || creating) {
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
                wrapperClassName="min-w-0 flex-[1_1_12rem]"
              />
              <button
                className="flex h-8 max-w-full shrink-0 items-center gap-1 rounded-[6px] bg-primary px-3 text-[13px] text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
                disabled={!newName.trim() || creating}
                onClick={handleCreateAndAdd}
                type="button"
              >
                {creating ? (
                  <>
                    <LoadingSpinner size="xs" variant="inherit" />
                    <span>{t("loading")}</span>
                  </>
                ) : (
                  t("albumCreate")
                )}
              </button>
            </div>
          ) : (
            <button
              className="flex w-full items-center gap-2 rounded-[6px] px-3 py-2 text-[13px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
              disabled={busy}
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
