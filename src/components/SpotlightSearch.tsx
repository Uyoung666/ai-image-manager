// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/suspicious/noExplicitAny: scoped component lint cleanup preserves existing UI behavior
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
import { toast } from "sonner";
import { filterSettingsNavigationItems } from "@/components/settings/SettingsSidebar";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAiStatus } from "@/hooks/useAiStatus";
import { ipc } from "@/ipc/manager";
import { getTagDisplayName } from "@/localization/tag-display";
import { toLocalMediaUrl } from "@/utils/local-media-url";

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
  coverBbox: { x: number; y: number; width: number; height: number } | null;
  coverPhotoHeight: number | null;
  coverPhotoPath: string | null;
  coverPhotoWidth: number | null;
  coverThumbnailPath: string | null;
  faceCount: number;
  id: number;
  name: string;
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
  const { data: aiStatus } = useAiStatus();
  const navigate = useNavigate();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Cache for relatively static data to avoid redundant IPC on every keystroke
  const staticCacheRef = useRef<{
    tags?: { data: TagResult[]; ts: number };
    albums?: { data: AlbumResult[]; ts: number };
    faces?: { data: PersonResult[]; ts: number };
  }>({});
  const CACHE_TTL = 30_000; // 30 seconds

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

  const searchGenRef = useRef(0);

  const searchPhotos = useCallback(
    async (q: string) => {
      if (!q.trim()) {
        setPhotoResults([]);
        setTagResults([]);
        setAlbumResults([]);
        setPersonResults([]);
        return;
      }
      const gen = ++searchGenRef.current;
      setSearching(true);
      const qLower = q.toLowerCase();
      try {
        const now = Date.now();
        // Use cached data for relatively static resources
        const cachedTags = staticCacheRef.current.tags;
        const cachedAlbums = staticCacheRef.current.albums;
        const cachedFaces = staticCacheRef.current.faces;

        const tagsPromise =
          cachedTags && now - cachedTags.ts < CACHE_TTL
            ? Promise.resolve(cachedTags.data)
            : ipc.client.photos.getTags({}).then((data) => {
                staticCacheRef.current.tags = {
                  data: data as TagResult[],
                  ts: Date.now(),
                };
                return data;
              });
        const albumsPromise =
          cachedAlbums && now - cachedAlbums.ts < CACHE_TTL
            ? Promise.resolve(cachedAlbums.data)
            : ipc.client.albums.listAlbums({}).then((data) => {
                staticCacheRef.current.albums = {
                  data: data as AlbumResult[],
                  ts: Date.now(),
                };
                return data;
              });
        const facesPromise =
          cachedFaces && now - cachedFaces.ts < CACHE_TTL
            ? Promise.resolve(cachedFaces.data)
            : ipc.client.faces.listFaceIdentities({}).then((data) => {
                staticCacheRef.current.faces = {
                  data: data as PersonResult[],
                  ts: Date.now(),
                };
                return data;
              });

        const [photos, tags, albums, faces] = await Promise.allSettled([
          (ipc.client.photos as any).searchSpotlight({
            query: q,
            limit: 8,
          }),
          tagsPromise,
          albumsPromise,
          facesPromise,
        ]);
        // 竞态保护：丢弃过时响应
        if (gen !== searchGenRef.current) {
          return;
        }
        const failed = [photos, tags, albums, faces].filter(
          (r) => r.status === "rejected"
        ).length;

        if (photos.status === "fulfilled") {
          setPhotoResults(
            ((photos.value as { results?: PhotoResult[] }).results || []).slice(
              0,
              5
            )
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
              .filter((p) => p.name?.toLowerCase().includes(qLower))
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
    },
    [t]
  );

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
  const settingResults = filterSettingsNavigationItems(query, t);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[9999]" data-wander-blocking="true">
      {/* Backdrop */}
      <button
        aria-label={t("close")}
        className="absolute inset-0 border-0 bg-black/50 p-0 backdrop-blur-sm"
        data-overlay-kind="command-search"
        data-surface="overlay-backdrop"
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            setOpen(false);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            setOpen(false);
          }
        }}
        type="button"
      />
      {/* Dialog */}
      <div className="absolute inset-x-0 top-2 mx-auto flex max-h-[calc(100dvh-1rem)] w-full max-w-[560px] px-3 sm:top-[10dvh] sm:max-h-[calc(90dvh-0.5rem)] sm:px-4">
        <Command
          className="surface-elevated flex max-h-full min-h-0 w-full flex-col overflow-hidden rounded-[12px] border border-border bg-popover shadow-2xl"
          data-overlay-kind="command-search"
          data-surface="overlay"
          loop
          shouldFilter={!query.trim()}
        >
          <div className="flex min-w-0 shrink-0 items-center border-border border-b px-3 sm:px-4">
            <Search className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
            <Command.Input
              className="flex h-12 w-full bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:shadow-none"
              onValueChange={setQuery}
              placeholder={t("spotlightSearchPlaceholder")}
              ref={inputRef}
              value={query}
            />
            <kbd className="ml-2 flex h-5 shrink-0 items-center rounded-[4px] border border-border bg-card px-1.5 font-mono text-[10px] text-muted-foreground">
              ESC
            </kbd>
          </div>
          {query.trim() &&
            aiStatus?.coverageState &&
            aiStatus.coverageState !== "ready" && (
              <div className="border-border border-b px-4 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                {aiStatus.coverageState === "error"
                  ? t("semanticSearchUnavailable")
                  : t("semanticSearchPartial", {
                      indexed: aiStatus.indexedPhotos,
                      total: aiStatus.totalPhotos,
                    })}
              </div>
            )}
          <Command.List className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
            {searching && (
              <div className="spotlight-loading-shield z-10 flex items-center justify-center bg-popover/50">
                <div className="flex items-center gap-2 rounded-[6px] bg-popover px-3 py-1.5 text-[12px] text-muted-foreground shadow-sm">
                  <LoadingSpinner size="xs" />
                  {t("searching")}
                </div>
              </div>
            )}
            <Command.Empty className="py-6 text-center text-[13px] text-muted-foreground">
              {searching ? t("searching") : t("noResultsFound")}
            </Command.Empty>

            {/* Photo results */}
            {photoResults.length > 0 && (
              <Command.Group
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                heading={t("photos")}
              >
                {photoResults.map((photo) => (
                  <Command.Item
                    className="flex min-w-0 cursor-pointer items-center gap-3 rounded-[6px] px-2 py-2 text-[13px] text-foreground aria-selected:bg-foreground/5"
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
                        height={32}
                        src={toLocalMediaUrl(photo.thumbnailPath)}
                        width={32}
                      />
                    ) : (
                      <div className="flex h-8 w-8 items-center justify-center rounded-[4px] bg-card">
                        <FileImage className="h-4 w-4 text-muted-foreground" />
                      </div>
                    )}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="min-w-0 flex-1 truncate">
                          {photo.filename}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-[min(28rem,calc(100vw-1rem))] break-all">
                        {photo.filename}
                      </TooltipContent>
                    </Tooltip>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {/* Tag results */}
            {tagResults.length > 0 && (
              <Command.Group
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                heading={t("sidebarTags")}
              >
                {tagResults.map((tag) => (
                  <Command.Item
                    className="flex min-w-0 cursor-pointer items-center gap-3 rounded-[6px] px-2 py-2 text-[13px] text-foreground aria-selected:bg-foreground/5"
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
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                heading={t("people")}
              >
                {personResults.map((person) => (
                  <Command.Item
                    className="flex cursor-pointer items-center gap-3 rounded-[6px] px-2 py-2 text-[13px] text-foreground aria-selected:bg-foreground/5"
                    key={`person-${person.id}`}
                    onSelect={() =>
                      handleSelect(() =>
                        navigate({
                          to: "/people/$identityId",
                          params: { identityId: String(person.id) },
                        })
                      )
                    }
                    value={`person ${person.name}`}
                  >
                    {person.coverThumbnailPath || person.coverPhotoPath ? (
                      <img
                        alt=""
                        className="h-7 w-7 rounded-full object-cover"
                        height={28}
                        src={toLocalMediaUrl(
                          person.coverThumbnailPath ||
                            person.coverPhotoPath ||
                            ""
                        )}
                        width={28}
                      />
                    ) : (
                      <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10">
                        <Users className="h-3.5 w-3.5 text-primary" />
                      </div>
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      {person.name}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {person.faceCount} {t("photos")}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {/* Album results */}
            {albumResults.length > 0 && (
              <Command.Group
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                heading={t("albums")}
              >
                {albumResults.map((album) => (
                  <Command.Item
                    className="flex min-w-0 cursor-pointer items-center gap-3 rounded-[6px] px-2 py-2 text-[13px] text-foreground aria-selected:bg-foreground/5"
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
                    <span className="min-w-0 flex-1 truncate">
                      {album.name}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {settingResults.length > 0 && (
              <Command.Group
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                heading={t("settingsTitle")}
              >
                {settingResults.map((item) => {
                  const label = t(item.labelKey);
                  const subtitle = t(item.groupKey);
                  const Icon = item.icon;

                  return (
                    <Command.Item
                      className="flex min-w-0 cursor-pointer items-center gap-3 rounded-[6px] px-2 py-2 text-[13px] text-foreground aria-selected:bg-foreground/5"
                      key={`setting-${item.to}`}
                      onSelect={() =>
                        handleSelect(() => navigate({ to: item.to }))
                      }
                      value={`settings ${label} ${subtitle} ${item.keywords}`}
                    >
                      <Icon className="h-4 w-4 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{label}</span>
                      <span className="shrink-0 truncate text-[11px] text-muted-foreground">
                        {subtitle}
                      </span>
                    </Command.Item>
                  );
                })}
              </Command.Group>
            )}

            {/* Navigation — 仅空输入时显示，输入后收起以让焦点直达搜索结果 */}
            {!query.trim() && (
              <Command.Group
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                heading={t("spotlightNavigationGroup")}
              >
                {navigationItems.map((item) => (
                  <Command.Item
                    className="flex min-w-0 cursor-pointer items-center gap-3 rounded-[6px] px-2 py-2 text-[13px] text-foreground aria-selected:bg-foreground/5"
                    key={item.id}
                    onSelect={() => handleSelect(item.action)}
                    value={`${item.title} ${item.subtitle || ""}`}
                  >
                    <span className="text-muted-foreground">{item.icon}</span>
                    <span className="min-w-0 flex-1 truncate">
                      {item.title}
                    </span>
                    {item.subtitle && (
                      <span className="shrink-0 truncate text-[11px] text-muted-foreground">
                        {item.subtitle}
                      </span>
                    )}
                  </Command.Item>
                ))}
              </Command.Group>
            )}
          </Command.List>

          {/* Footer */}
          <div className="flex shrink-0 items-center justify-between overflow-x-auto border-border border-t px-3 py-2 sm:px-4">
            <div className="flex shrink-0 items-center gap-3 text-[11px] text-muted-foreground">
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
