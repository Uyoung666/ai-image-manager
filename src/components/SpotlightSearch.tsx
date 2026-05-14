import { Command } from "cmdk";
import { useNavigate } from "@tanstack/react-router";
import {
  Album,
  FileImage,
  LayoutDashboard,
  ScanSearch,
  Search,
  Settings,
  Star,
  Tag,
  Trash2,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "@/ipc/manager";

function toLocalMediaUrl(filePath: string | null | undefined): string {
  if (!filePath) return "";
  const encoded = filePath
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `local-media://${encoded}`;
}

interface SearchResult {
  id: string;
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  action: () => void;
  group: string;
}

interface PhotoResult {
  id: number;
  filename: string;
  path: string;
  thumbnailPath: string | null;
}

interface TagResult {
  id: number;
  name: string;
  color: string | null;
}

interface AlbumResult {
  id: number;
  name: string;
}

export function SpotlightSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [photoResults, setPhotoResults] = useState<PhotoResult[]>([]);
  const [tagResults, setTagResults] = useState<TagResult[]>([]);
  const [albumResults, setAlbumResults] = useState<AlbumResult[]>([]);
  const [searching, setSearching] = useState(false);
  const navigate = useNavigate();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      return;
    }
    setSearching(true);
    try {
      const [photos, tags, albums] = await Promise.all([
        ipc.client.photos.listPhotos({
          search: q,
          limit: 5,
          offset: 0,
        }),
        ipc.client.photos.getTags({}),
        ipc.client.albums.listAlbums({}),
      ]);
      setPhotoResults(
        (photos.items as PhotoResult[]).slice(0, 5)
      );
      setTagResults(
        ((tags as TagResult[]) || [])
          .filter((t) => t.name.toLowerCase().includes(q.toLowerCase()))
          .slice(0, 5)
      );
      setAlbumResults(
        ((albums as AlbumResult[]) || [])
          .filter((a) => a.name.toLowerCase().includes(q.toLowerCase()))
          .slice(0, 5)
      );
    } catch {
      // ignore
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      searchPhotos(query);
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
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
      title: "所有照片",
      subtitle: "浏览全部照片",
      icon: <FileImage className="h-4 w-4" />,
      action: () => navigate({ to: "/" }),
      group: "导航",
    },
    {
      id: "nav-favorites",
      title: "收藏",
      subtitle: "查看收藏的照片",
      icon: <Star className="h-4 w-4" />,
      action: () => navigate({ to: "/" }),
      group: "导航",
    },
    {
      id: "nav-albums",
      title: "相册",
      subtitle: "管理相册",
      icon: <Album className="h-4 w-4" />,
      action: () => navigate({ to: "/albums" }),
      group: "导航",
    },
    {
      id: "nav-people",
      title: "人物识别",
      subtitle: "按人物浏览照片",
      icon: <Users className="h-4 w-4" />,
      action: () => navigate({ to: "/people" }),
      group: "导航",
    },
    {
      id: "nav-duplicates",
      title: "重复照片检测",
      subtitle: "查找并管理重复照片",
      icon: <ScanSearch className="h-4 w-4" />,
      action: () => navigate({ to: "/duplicates" }),
      group: "导航",
    },
    {
      id: "nav-dashboard",
      title: "EXIF 仪表盘",
      subtitle: "可视化拍摄习惯",
      icon: <LayoutDashboard className="h-4 w-4" />,
      action: () => navigate({ to: "/dashboard" }),
      group: "导航",
    },
    {
      id: "nav-trash",
      title: "最近删除",
      subtitle: "查看已删除的照片",
      icon: <Trash2 className="h-4 w-4" />,
      action: () => navigate({ to: "/trash" }),
      group: "导航",
    },
    {
      id: "nav-settings",
      title: "设置",
      subtitle: "应用设置",
      icon: <Settings className="h-4 w-4" />,
      action: () => navigate({ to: "/settings" }),
      group: "导航",
    },
  ];

  if (!open) return null;

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
              className="flex h-12 w-full bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted-foreground"
              onValueChange={setQuery}
              placeholder="搜索照片、相册、标签、设置..."
              value={query}
            />
            <kbd className="ml-2 flex h-5 shrink-0 items-center rounded-[4px] border border-border bg-card px-1.5 font-mono text-[10px] text-muted-foreground">
              ESC
            </kbd>
          </div>
          <Command.List className="max-h-[360px] overflow-y-auto p-2">
            <Command.Empty className="py-6 text-center text-[13px] text-muted-foreground">
              {searching ? "搜索中..." : "没有找到结果"}
            </Command.Empty>

            {/* Photo results */}
            {photoResults.length > 0 && (
              <Command.Group
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-[510] [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                heading="照片"
              >
                {photoResults.map((photo) => (
                  <Command.Item
                    className="flex cursor-pointer items-center gap-3 rounded-[6px] px-2 py-2 text-[13px] text-foreground aria-selected:bg-foreground/5"
                    key={`photo-${photo.id}`}
                    onSelect={() =>
                      handleSelect(() => navigate({ to: "/" }))
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
                heading="标签"
              >
                {tagResults.map((tag) => (
                  <Command.Item
                    className="flex cursor-pointer items-center gap-3 rounded-[6px] px-2 py-2 text-[13px] text-foreground aria-selected:bg-foreground/5"
                    key={`tag-${tag.id}`}
                    onSelect={() =>
                      handleSelect(() => navigate({ to: "/" }))
                    }
                    value={`tag ${tag.name}`}
                  >
                    <span
                      className="h-3 w-3 rounded-full"
                      style={{ background: tag.color || "var(--primary)" }}
                    />
                    <span>{tag.name}</span>
                    <Tag className="ml-auto h-3 w-3 text-muted-foreground" />
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {/* Album results */}
            {albumResults.length > 0 && (
              <Command.Group
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-[510] [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
                heading="相册"
              >
                {albumResults.map((album) => (
                  <Command.Item
                    className="flex cursor-pointer items-center gap-3 rounded-[6px] px-2 py-2 text-[13px] text-foreground aria-selected:bg-foreground/5"
                    key={`album-${album.id}`}
                    onSelect={() =>
                      handleSelect(() =>
                        navigate({ to: "/albums/$albumId", params: { albumId: String(album.id) } })
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
              heading="导航"
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
                <kbd className="rounded-[3px] border border-border bg-card px-1 font-mono text-[10px]">↑↓</kbd>
                导航
              </span>
              <span className="flex items-center gap-1">
                <kbd className="rounded-[3px] border border-border bg-card px-1 font-mono text-[10px]">↵</kbd>
                选择
              </span>
              <span className="flex items-center gap-1">
                <kbd className="rounded-[3px] border border-border bg-card px-1 font-mono text-[10px]">Esc</kbd>
                关闭
              </span>
            </div>
          </div>
        </Command>
      </div>
    </div>
  );
}
