import { useNavigate } from "@tanstack/react-router";
import { Command } from "cmdk";
import {
  Album,
  FileImage,
  LayoutDashboard,
  ScanSearch,
  Search,
  Settings,
  Star,
  Swords,
  Tag,
  Trash2,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/ipc/manager";
import { getTagDisplayName } from "@/localization/tag-display";
import { toLocalMediaUrl } from "@/utils/local-media-url";
import { toast } from "sonner";

interface SearchResult {
  action: () => void;
  group: string;
  icon: React.ReactNode;
  id: string;
  subtitle?: string;
  title: string;
}

interface PhotoResult {
  filename: string;
  id: number;
  path: string;
  thumbnailPath: string | null;
}

interface TagResult {
  color: string | null;
  id: number;
  name: string;
}

interface AlbumResult {
  id: number;
  name: string;
}

interface PersonResult {
  id: number;
  name: string;
  faceCount: number;
}

export function SpotlightSearch() {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [photoResults, setPhotoResults] = useState<PhotoResult[]>([]);
  const [tagResults, setTagResults] = useState<TagResult[]>([]);
  const [albumResults, setAlbumResults] = useState<AlbumResult[]>([]);
  const [personResults, setPersonResults] = useState<PersonResult[]>([]);
  const [searching, setSearching] = useState(false);
  const navigate = useNavigate();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus search input when panel opens
  useEffect(() => {
    if (open) {
      // RAF ensures DOM is painted before focus
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  const searchPhotos = useCallback(async (q: string) => {
    if (!q.trim()) {
      setPhotoResults([]);
      setTagResults([]);
      setAlbumResults([]);
      setPersonResults([]);
      return;
    }
    setSearching(true);
    const qLower = q.toLowerCase();
    try {
      const [photos, tags, albums, faces] = await Promise.allSettled([
        ipc.client.photos.searchCompound({
          query: q,
          limit: 5,
        }),
        ipc.client.photos.getTags({}),
        ipc.client.albums.listAlbums({}),
        ipc.client.faces.listFaceIdentities({}),
      ]);
      const failed = [photos, tags, albums, faces].filter(
        (r) => r.status === "rejected"
      ).length;

      if (photos.status === "fulfilled") {
        setPhotoResults(
          ((photos.value as { results?: PhotoResult[] }).results || []).slice(0, 5)
        );
      }
      if (tags.status === "fulfilled") {
        setTagResults(
          ((tags.value as TagResult[]) || [])
            .filter((t) => t.name.toLowerCase().includes(qLower))
            .slice(0, 5)
        );
      }
      if (albums.status === "fulfilled") {
        setAlbumResults(
          ((albums.value as AlbumResult[]) || [])
            .filter((a) => a.name.toLowerCase().includes(qLower))
            .slice(0, 5)
        );
      }
      if (faces.status === "fulfilled") {
        setPersonResults(
          ((faces.value as PersonResult[]) || [])
            .filter(
              (p) =>
                p.name && p.name.toLowerCase().includes(qLower)
            )
            .slice(0, 5)
        );
      }
      if (failed > 0 && failed < 4) {
        toast.error(t("searchPartialFailed"));
      } else if (failed === 4) {
        toast.error(t("toastSearchFailed"));
      }
    } catch {
      toast.error(t("toastSearchFailed"));
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      searchPhotos(query);
    }, 200);
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [query, searchPhotos]);

  function handleSelect(action: () => void) {
    action();
    setOpen(false);
    setQuery("");
  }

  const navigationItems: SearchResult[] = [
    {
      id: "nav-home",
      title: t("spotlightAllPhotosTitle"),
      subtitle: t("spotlightAllPhotosSubtitle"),
      icon: <FileImage className="h-4 w-4" />,
      action: () => navigate({ to: "/", search: { reset: true } }),
      group: t("spotlightNavigationGroup"),
    },
    {
      id: "nav-favorites",
      title: t("favorites"),
      subtitle: t("spotlightFavoritesSubtitle"),
      icon: <Star className="h-4 w-4" />,
      action: () => navigate({ to: "/", search: { favoriteOnly: true } }),
      group: t("spotlightNavigationGroup"),
    },
    {
      id: "nav-albums",
      title: t("albums"),
      subtitle: t("spotlightAlbumsSubtitle"),
      icon: <Album className="h-4 w-4" />,
      action: () => navigate({ to: "/albums" }),
      group: t("spotlightNavigationGroup"),
    },
    {
      id: "nav-people",
      title: t("people"),
      subtitle: t("spotlightPeopleSubtitle"),
      icon: <Users className="h-4 w-4" />,
      action: () => navigate({ to: "/people" }),
      group: t("spotlightNavigationGroup"),
    },
    {
      id: "nav-duplicates",
      title: t("duplicates"),
      subtitle: t("spotlightDuplicatesSubtitle"),
      icon: <ScanSearch className="h-4 w-4" />,
      action: () => navigate({ to: "/duplicates" }),
      group: t("spotlightNavigationGroup"),
    },
    {
      id: "nav-cull",
      title: t("cullTitle"),
      subtitle: t("spotlightCullSubtitle"),
      icon: <Swords className="h-4 w-4" />,
      action: () => navigate({ to: "/cull" }),
      group: t("spotlightNavigationGroup"),
    },
    {
      id: "nav-dashboard",
      title: t("spotlightDashboardTitle"),
      subtitle: t("spotlightDashboardSubtitle"),
      icon: <LayoutDashboard className="h-4 w-4" />,
      action: () => navigate({ to: "/dashboard" }),
      group: t("spotlightNavigationGroup"),
    },
    {
      id: "nav-trash",
      title: t("trash"),
      subtitle: t("spotlightTrashSubtitle"),
      icon: <Trash2 className="h-4 w-4" />,
      action: () => navigate({ to: "/trash" }),
      group: t("spotlightNavigationGroup"),
    },
    {
      id: "nav-settings",
      title: t("sidebarSettings"),
      subtitle: t("spotlightSettingsSubtitle"),
      icon: <Settings className="h-4 w-4" />,
      action: () => navigate({ to: "/settings" }),
      group: t("spotlightNavigationGroup"),
    },
  ];

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[9999]">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={() => setOpen(false)}
      />
      {/* Dialog */}
      <div className="absolute top-[20%] right-0 left-0 mx-auto w-full max-w-[560px] px-4">
        <Command
          className="overflow-hidden rounded-[12px] border border-border bg-popover shadow-2xl"
          loop
          shouldFilter={!query.trim()}
        >
          <div className="flex items-center border-border border-b px-4">
            <Search className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
            <Command.Input
              ref={inputRef}
              className="flex h-12 w-full bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted-foreground"
              onValueChange={setQuery}
              placeholder={t("spotlightSearchPlaceholder")}
              value={query}
            />
            <kbd className="ml-2 flex h-5 shrink-0 items-center rounded-[4px] border border-border bg-card px-1.5 font-mono text-[10px] text-muted-foreground">
              ESC
            </kbd>
          </div>
          <Command.List className="max-h-[360px] overflow-y-auto p-2">
            <Command.Empty className="py-6 text-center text-[13px] text-muted-foreground">
              {searching ? t("searching") : t("noResultsFound")}
            </Command.Empty>

            {/* Photo results */}
            {photoResults.length > 0 && (
              <Command.Group
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-[510] [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                heading={t("photos")}
              >
                {photoResults.map((photo) => (
                  <Command.Item
                    className="flex cursor-pointer items-center gap-3 rounded-[6px] px-2 py-2 text-[13px] text-foreground aria-selected:bg-foreground/5"
                    key={`photo-${photo.id}`}
                    onSelect={() =>
                      handleSelect(() =>
                        navigate({ to: "/", search: { searchQuery: query } })
                      )
                    }
                    value={`photo ${photo.filename}`}
                  >
                    {photo.thumbnailPath ? (
                      <img
                        alt=""
                        className="h-8 w-8 rounded-[4px] object-cover"
                        src={toLocalMediaUrl(photo.thumbnailPath)}
                      />
                    ) : (
                      <div className="flex h-8 w-8 items-center justify-center rounded-[4px] bg-card">
                        <FileImage className="h-4 w-4 text-muted-foreground" />
                      </div>
                    )}
                    <span className="truncate">{photo.filename}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {/* Tag results */}
            {tagResults.length > 0 && (
              <Command.Group
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-[510] [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                heading={t("sidebarTags")}
              >
                {tagResults.map((tag) => (
                  <Command.Item
                    className="flex cursor-pointer items-center gap-3 rounded-[6px] px-2 py-2 text-[13px] text-foreground aria-selected:bg-foreground/5"
                    key={`tag-${tag.id}`}
                    onSelect={() =>
                      handleSelect(() =>
                        navigate({
                          to: "/",
                          search: { tagId: tag.id },
                        })
                      )
                    }
                    value={`tag ${tag.name}`}
                  >
                    <span
                      className="h-3 w-3 rounded-full"
                      style={{ background: tag.color || "var(--primary)" }}
                    />
                    <span>{getTagDisplayName(tag.name, i18n.language)}</span>
                    <Tag className="ml-auto h-3 w-3 text-muted-foreground" />
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {/* Person results */}
            {personResults.length > 0 && (
              <Command.Group
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-[510] [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                heading={t("people")}
              >
                {personResults.map((person) => (
                  <Command.Item
                    className="flex cursor-pointer items-center gap-3 rounded-[6px] px-2 py-2 text-[13px] text-foreground aria-selected:bg-foreground/5"
                    key={`person-${person.id}`}
                    onSelect={() =>
                      handleSelect(() =>
                        navigate({
                          to: "/",
                          search: { searchQuery: person.name },
                        })
                      )
                    }
                    value={`person ${person.name}`}
                  >
                    <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10">
                      <Users className="h-3.5 w-3.5 text-primary" />
                    </div>
                    <span>{person.name}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {person.faceCount} {t("photos")}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {/* Album results */}
            {albumResults.length > 0 && (
              <Command.Group
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-[510] [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                heading={t("albums")}
              >
                {albumResults.map((album) => (
                  <Command.Item
                    className="flex cursor-pointer items-center gap-3 rounded-[6px] px-2 py-2 text-[13px] text-foreground aria-selected:bg-foreground/5"
                    key={`album-${album.id}`}
                    onSelect={() =>
                      handleSelect(() =>
                        navigate({
                          to: "/albums/$albumId",
                          params: { albumId: String(album.id) },
                        })
                      )
                    }
                    value={`album ${album.name}`}
                  >
                    <Album className="h-4 w-4 text-muted-foreground" />
                    <span>{album.name}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {/* Navigation */}
            <Command.Group
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-[510] [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
              heading={t("spotlightNavigationGroup")}
            >
              {navigationItems.map((item) => (
                <Command.Item
                  className="flex cursor-pointer items-center gap-3 rounded-[6px] px-2 py-2 text-[13px] text-foreground aria-selected:bg-foreground/5"
                  key={item.id}
                  onSelect={() => handleSelect(item.action)}
                  value={`${item.title} ${item.subtitle || ""}`}
                >
                  <span className="text-muted-foreground">{item.icon}</span>
                  <span>{item.title}</span>
                  {item.subtitle && (
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      {item.subtitle}
                    </span>
                  )}
                </Command.Item>
              ))}
            </Command.Group>
          </Command.List>

          {/* Footer */}
          <div className="flex items-center justify-between border-border border-t px-4 py-2">
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <kbd className="rounded-[3px] border border-border bg-card px-1 font-mono text-[10px]">
                  ↑↓
                </kbd>
                {t("navigation")}
              </span>
              <span className="flex items-center gap-1">
                <kbd className="rounded-[3px] border border-border bg-card px-1 font-mono text-[10px]">
                  ↵
                </kbd>
                {t("select")}
              </span>
              <span className="flex items-center gap-1">
                <kbd className="rounded-[3px] border border-border bg-card px-1 font-mono text-[10px]">
                  Esc
                </kbd>
                {t("close")}
              </span>
            </div>
          </div>
        </Command>
      </div>
    </div>
  );
}
