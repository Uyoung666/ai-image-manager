import {
  createFileRoute,
  Link,
  Outlet,
  useMatch,
  useNavigate,
} from "@tanstack/react-router";
import { ArrowLeft, FolderPlus, Sparkles, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { RouteError } from "@/components/RouteError";
import { SmartAlbumDialog } from "@/components/SmartAlbumDialog";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
import { ipc } from "@/ipc/manager";
import { getDateLocale } from "@/utils/date-locale";
import { toLocalMediaUrl } from "@/utils/local-media-url";

interface AlbumInfo {
  coverPhotoId: number | null;
  coverThumbnailPath?: string | null;
  createdAt: number;
  description: string | null;
  id: number;
  isSmart: boolean;
  name: string;
}

const ALBUM_SKELETON_KEYS = [
  "album-skeleton-1",
  "album-skeleton-2",
  "album-skeleton-3",
  "album-skeleton-4",
  "album-skeleton-5",
];

function AlbumCover({
  album,
  coverPath,
}: {
  album: AlbumInfo;
  coverPath?: string;
}) {
  if (coverPath) {
    return (
      <img
        alt={album.name}
        className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.025]"
        draggable={false}
        height={400}
        src={toLocalMediaUrl(coverPath)}
        width={640}
      />
    );
  }

  return (
    <div className="flex h-full w-full items-center justify-center text-muted-foreground">
      {album.isSmart ? (
        <Zap className="h-8 w-8 text-muted-foreground/20" />
      ) : (
        <svg
          aria-hidden="true"
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
  );
}

function AlbumCard({
  album,
  covers,
}: {
  album: AlbumInfo;
  covers: Map<number, string>;
}) {
  const { t, i18n } = useTranslation();
  const coverPath = album.coverPhotoId
    ? covers.get(album.coverPhotoId)
    : undefined;
  const dateLabel = album.isSmart
    ? t("smartAlbum")
    : new Date(album.createdAt).toLocaleDateString(
        getDateLocale(i18n.language)
      );

  return (
    <Link
      className={`group overflow-hidden rounded-[10px] bg-card shadow-xs transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md ${
        album.isSmart ? "border border-primary/20" : "border border-border"
      }`}
      draggable={false}
      params={{ albumId: album.id.toString() }}
      to="/albums/$albumId"
    >
      <div className="aspect-[16/10] overflow-hidden bg-muted">
        <AlbumCover album={album} coverPath={coverPath} />
      </div>
      <div className="p-4">
        <div className="flex items-center gap-1.5">
          {album.isSmart && <Zap className="h-3 w-3 text-primary" />}
          <h3 className="min-w-0 truncate font-medium text-[14px] text-foreground">
            {album.name}
          </h3>
        </div>
        {album.description && (
          <p className="mt-1 truncate text-[12px] text-muted-foreground">
            {album.description}
          </p>
        )}
        <p className="mt-2 text-[11px] text-muted-foreground">{dateLabel}</p>
      </div>
    </Link>
  );
}

function AlbumsContent({
  albums,
  covers,
  loading,
  onCreate,
}: {
  albums: AlbumInfo[];
  covers: Map<number, string>;
  loading: boolean;
  onCreate: () => void;
}) {
  const { t } = useTranslation();

  if (loading) {
    return (
      <div className="grid w-full min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-4 sm:gap-5">
        {ALBUM_SKELETON_KEYS.map((key) => (
          <div
            className="aspect-[16/12] animate-pulse rounded-[10px] bg-card"
            key={key}
          />
        ))}
      </div>
    );
  }

  if (albums.length === 0) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3 text-center">
        <svg
          aria-hidden="true"
          className="text-muted-foreground/70/40"
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
        <p className="font-medium text-[14px] text-foreground">
          {t("noAlbumsTitle")}
        </p>
        <p className="max-w-[260px] text-[12px] text-muted-foreground/70">
          {t("noAlbumsDescription")}
        </p>
        <button
          className="mt-1 rounded-[6px] bg-primary px-4 py-1.5 font-medium text-[13px] text-white transition-opacity hover:opacity-90"
          onClick={onCreate}
          type="button"
        >
          {t("createFirstAlbum")}
        </button>
      </div>
    );
  }

  return (
    <div className="grid w-full min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-4 sm:gap-5">
      {albums.map((album) => (
        <AlbumCard album={album} covers={covers} key={album.id} />
      ))}
      <button
        className="group flex min-h-[260px] flex-col items-center justify-center gap-3 rounded-[10px] border border-border border-dashed bg-secondary/40 text-center transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:bg-primary/5 hover:shadow-sm"
        onClick={onCreate}
        type="button"
      >
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary transition-transform group-hover:scale-105">
          <FolderPlus className="h-5 w-5" />
        </span>
        <span>
          <span className="block font-medium text-[14px] text-foreground">
            {t("albumNew")}
          </span>
          <span className="mt-1 block text-[12px] text-muted-foreground">
            {t("albumNewHint")}
          </span>
        </span>
      </button>
    </div>
  );
}

function AlbumsPage() {
  const { t } = useTranslation();
  const [albums, setAlbums] = useState<AlbumInfo[]>([]);
  const [covers, setCovers] = useState<Map<number, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [creating, setCreating] = useState(false);
  const [showSmartDialog, setShowSmartDialog] = useState(false);
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  useRouteScrollRestoration(scrollRef, { getRouteKey: () => "albums-list" });

  const loadAlbums = useCallback(async () => {
    try {
      const result = await ipc.client.albums.listAlbums({});
      const list = result as AlbumInfo[];
      setAlbums(list);

      const coverMap = new Map<number, string>();
      for (const album of list) {
        if (album.coverPhotoId && album.coverThumbnailPath) {
          coverMap.set(album.coverPhotoId, album.coverThumbnailPath);
        }
      }
      setCovers(coverMap);
    } catch (err) {
      console.error("[loadAlbums] failed:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAlbums();
  }, [loadAlbums]);

  async function handleCreate() {
    const name = newName.trim();
    if (!name) {
      return;
    }
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
      toast.error(t("albumCreateFailed"));
    }
    setCreating(false);
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-border border-b px-4 py-3 sm:px-6 sm:py-4">
        <div className="flex min-w-0 items-center gap-3">
          <button
            className="flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            onClick={() => navigate({ to: "/" })}
            type="button"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="min-w-0">
            <h1 className="font-semibold text-[24px] text-foreground tracking-tight">
              {t("albums")}
            </h1>
            <p className="mt-0.5 text-[12px] text-muted-foreground/70">
              {t("albumsCount", { count: albums.length })}
            </p>
          </div>
        </div>
        <div className="flex max-w-full flex-wrap justify-end gap-2">
          <button
            className="flex items-center gap-1.5 rounded-[6px] border border-primary/40 px-4 py-1.5 font-medium text-[13px] text-primary transition-colors hover:border-primary hover:bg-primary/5"
            onClick={() => setShowSmartDialog(true)}
            type="button"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {t("smartAlbum")}
          </button>
          <button
            className="rounded-[6px] bg-primary px-4 py-1.5 font-medium text-[13px] text-white transition-opacity hover:opacity-90"
            onClick={() => setShowCreate(true)}
            type="button"
          >
            {t("albumNew")}
          </button>
        </div>
      </div>

      {/* Create dialog inline */}
      {showCreate && (
        <div className="border-border border-b px-4 py-3 sm:px-6 sm:py-4">
          <div className="flex flex-wrap gap-3">
            <input
              autoFocus
              className="h-8 min-w-[min(100%,12rem)] flex-1 rounded-[6px] border border-input bg-card px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleCreate();
                }
                if (e.key === "Escape") {
                  setShowCreate(false);
                }
              }}
              placeholder={t("smartAlbumNamePlaceholder")}
              value={newName}
            />
            <input
              className="h-8 min-w-[min(100%,12rem)] flex-1 rounded-[6px] border border-input bg-card px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary"
              onChange={(e) => setNewDesc(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleCreate();
                }
                if (e.key === "Escape") {
                  setShowCreate(false);
                }
              }}
              placeholder={t("albumDescriptionPlaceholder")}
              value={newDesc}
            />
            <button
              className="rounded-[6px] border border-input px-4 py-1.5 text-[13px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
              disabled={!newName.trim() || creating}
              onClick={handleCreate}
              type="button"
            >
              {t("albumCreate")}
            </button>
            <button
              className="rounded-[6px] border border-input px-4 py-1.5 text-[13px] text-muted-foreground transition-colors hover:border-muted-foreground hover:text-foreground"
              onClick={() => setShowCreate(false)}
              type="button"
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      )}

      {/* Grid */}
      <div
        className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6"
        ref={scrollRef}
      >
        <AlbumsContent
          albums={albums}
          covers={covers}
          loading={loading}
          onCreate={() => setShowCreate(true)}
        />
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

export const Route = createFileRoute("/albums" as const)({
  component: AlbumsLayout,
  errorComponent: RouteError,
});
