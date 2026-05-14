import { useNavigate } from "@tanstack/react-router";
import {
  Album,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Folder,
  LayoutDashboard,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  ScanSearch,
  Settings,
  Star,
  Tag,
  Trash2,
  Users,
} from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ipc } from "@/ipc/manager";
import { queryClient } from "@/providers/QueryProvider";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { AiProgressBar } from "./AiProgressBar";

interface FolderInfo {
  displayName: string;
  id: number;
  path: string;
  photoCount: number;
}
interface TagInfo {
  color: string | null;
  id: number;
  name: string;
  photoCount: number;
}
interface SidebarProps {
  activeFolderId: number | null;
  collapsed: boolean;
  favoriteActive?: boolean;
  folders: FolderInfo[];
  onAddFolder: () => void;
  onDeleteFolder: (id: number, displayName: string) => void;
  onSelectFavorites?: () => void;
  onSelectFolder: (id: number | null) => void;
  onSelectTag?: (tagId: number | null) => void;
  onToggleCollapse: () => void;
  scanningFolder: string | null;
  scanProgress: string;
  totalPhotos: number;
}

interface FolderTreeNode {
  children: FolderTreeNode[];
  folder: FolderInfo;
}

function dirname(filePath: string): string {
  const i = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return i < 0 ? "" : filePath.slice(0, i);
}

function buildFolderTree(folders: FolderInfo[]): FolderTreeNode[] {
  const nodeMap = new Map<number, FolderTreeNode>();
  const roots: FolderTreeNode[] = [];

  // Sort by path length so parents come before children
  const sorted = [...folders].sort((a, b) => a.path.length - b.path.length);

  for (const f of sorted) {
    nodeMap.set(f.id, { folder: f, children: [] });
  }

  for (const f of sorted) {
    const parentPath = dirname(f.path);
    const parent = sorted.find((p) => p.path === parentPath);
    if (parent) {
      const parentNode = nodeMap.get(parent.id);
      const childNode = nodeMap.get(f.id);
      if (parentNode && childNode) {
        parentNode.children.push(childNode);
      }
    } else {
      const node = nodeMap.get(f.id);
      if (node) roots.push(node);
    }
  }

  return roots;
}

function renderFolderTree(
  nodes: FolderTreeNode[],
  depth: number,
  expandedIds: Set<number>,
  onToggle: (id: number) => void,
  activeId: number | null,
  onSelect: (id: number) => void,
  onContextMenu: (e: React.MouseEvent, id: number, name: string) => void,
): ReactNode[] {
  return nodes.flatMap((node) => {
    const hasChildren = node.children.length > 0;
    const isExpanded = expandedIds.has(node.folder.id);
    const isActive = activeId === node.folder.id;

    const row = (
      <div className="flex items-center" key={node.folder.id}>
        <button
          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-[4px] text-muted-foreground/70 hover:text-foreground"
          style={{ marginLeft: depth * 14 }}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(node.folder.id);
          }}
        >
          {hasChildren ? (
            <ChevronRight
              className={`h-3 w-3 transition-transform ${isExpanded ? "rotate-90" : ""}`}
            />
          ) : (
            <span className="w-3" />
          )}
        </button>
        <button
          className={`flex flex-1 items-center gap-2 rounded-[6px] px-3 py-1.5 text-left text-[13px] transition-colors ${
            isActive
              ? "bg-primary/15 text-primary"
              : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          }`}
          onClick={() => onSelect(node.folder.id)}
          onContextMenu={(e) =>
            onContextMenu(e, node.folder.id, node.folder.displayName)
          }
        >
          <Folder className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="truncate">{node.folder.displayName}</span>
          <span className="ml-auto text-muted-foreground/70 text-[10px] tabular-nums">
            {node.folder.photoCount}
          </span>
        </button>
      </div>
    );

    return hasChildren && isExpanded
      ? [row, ...renderFolderTree(node.children, depth + 1, expandedIds, onToggle, activeId, onSelect, onContextMenu)]
      : [row];
  });
}

export function Sidebar({
  folders,
  activeFolderId,
  collapsed,
  favoriteActive,
  onSelectFolder,
  onSelectFavorites,
  onAddFolder,
  onDeleteFolder,
  onSelectTag,
  onToggleCollapse,
  scanningFolder,
  scanProgress,
  totalPhotos,
}: SidebarProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [folderCtx, setFolderCtx] = useState<{
    folderId: number;
    displayName: string;
    x: number;
    y: number;
  } | null>(null);
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [activeTagId, setActiveTagId] = useState<number | null>(null);
  const [tagSearch, setTagSearch] = useState("");
  const ctxRef = useRef<HTMLDivElement>(null);
  const [dragOverTagId, setDragOverTagId] = useState<number | null>(null);
  const [dragOverAlbumNav, setDragOverAlbumNav] = useState(false);
  const [foldersCollapsed, setFoldersCollapsed] = useState(false);
  const [tagsCollapsed, setTagsCollapsed] = useState(false);
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<number>>(
    new Set()
  );
  const [deleteTagTarget, setDeleteTagTarget] = useState<{
    id: number;
    name: string;
  } | null>(null);
  const [tagPopoverOpen, setTagPopoverOpen] = useState(false);

  // Drag-and-drop: album/tag drop targets
  function handlePhotoDragOver(e: React.DragEvent) {
    if (e.dataTransfer.types.includes("application/x-photo-ids")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  }

  async function handleDropOnTag(e: React.DragEvent, tagId: number) {
    setDragOverTagId(null);
    const raw = e.dataTransfer.getData("application/x-photo-ids");
    if (!raw) return;
    const ids: number[] = JSON.parse(raw);
    const tag = tags.find((t) => t.id === tagId);
    let failed = 0;
    for (const photoId of ids) {
      try {
        await ipc.client.photos.setPhotoTag({ photoId, tagId });
      } catch {
        failed++;
      }
    }
    queryClient.invalidateQueries({ queryKey: ["photos"] });
    if (failed > 0) {
      toast.success(`已为 ${ids.length - failed} 张照片添加标签「${tag?.name || ""}」`);
    } else {
      toast.success(`已为 ${ids.length} 张照片添加标签「${tag?.name || ""}」`);
    }
  }

  async function handleDropOnAlbumNav(e: React.DragEvent) {
    setDragOverAlbumNav(false);
    const raw = e.dataTransfer.getData("application/x-photo-ids");
    if (!raw) return;
    const ids: number[] = JSON.parse(raw);
    // Open AddToAlbumDialog — for now navigate to albums page as fallback
    // Dispatch a custom event so the parent can intercept it
    window.dispatchEvent(
      new CustomEvent("photo-drop:album", { detail: { photoIds: ids } }),
    );
  }

  useEffect(() => {
    let running = true;
    let interval: ReturnType<typeof setInterval> | null = null;

    async function loadTags() {
      try {
        const result = await ipc.client.photos.getTags({
          folderId: activeFolderId ?? undefined,
        });
        if (!running) return;
        const tagList = (result as TagInfo[]) || [];
        setTags(tagList);
        // Clear active tag if it's no longer in the filtered list
        if (activeTagId && !tagList.some((t) => t.id === activeTagId)) {
          setActiveTagId(null);
          onSelectTag?.(null);
        }
        // Stop polling once tags appear
        if (tagList.length > 0 && interval) {
          clearInterval(interval);
          interval = null;
        }
      } catch { /* ignore */ }
    }

    loadTags();
    // Poll for tags if photos exist but tags haven't loaded yet
    if (totalPhotos > 0) {
      interval = setInterval(loadTags, 5000);
    }

    return () => {
      running = false;
      if (interval) clearInterval(interval);
    };
  }, [totalPhotos, activeFolderId]);

  const closeCtx = useCallback(() => setFolderCtx(null), []);

  async function handleDeleteTag() {
    if (!deleteTagTarget) return;
    const { id, name } = deleteTagTarget;
    setDeleteTagTarget(null);
    try {
      await ipc.client.photos.deleteTag({ id });
      const updated = await ipc.client.photos.getTags({
        folderId: activeFolderId ?? undefined,
      });
      setTags((updated as TagInfo[]) || []);
      if (activeTagId === id) {
        setActiveTagId(null);
        onSelectTag?.(null);
      }
      toast.success(`已删除标签「${name}」`);
    } catch {
      toast.error("删除标签失败");
    }
  }

  useEffect(() => {
    if (!folderCtx) return;
    function handleClick(e: MouseEvent) {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) {
        closeCtx();
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeCtx();
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [folderCtx, closeCtx]);

  const folderTree = buildFolderTree(folders);

  // Auto-expand root-level parent folders on first load
  const prevFolderCount = useRef(folders.length);
  useEffect(() => {
    if (folders.length !== prevFolderCount.current) {
      prevFolderCount.current = folders.length;
      const rootsWithChildren = folderTree
        .filter((n) => n.children.length > 0)
        .map((n) => n.folder.id);
      if (rootsWithChildren.length > 0) {
        setExpandedFolderIds(new Set(rootsWithChildren));
      }
    }
  }, [folders.length]);

  function handleFolderContextMenu(
    e: React.MouseEvent,
    folderId: number,
    displayName: string
  ) {
    e.preventDefault();
    setFolderCtx({ folderId, displayName, x: e.clientX, y: e.clientY });
  }

  // Collapsed: icon-only bar
  if (collapsed) {
    return (
      <div className="flex h-full w-12 flex-col items-center border-border border-r bg-secondary py-3">
        <button
          className="mb-2 flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground/70 transition-colors hover:bg-foreground/5 hover:text-foreground"
          onClick={onToggleCollapse}
          title="展开侧边栏"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>

        <div className="flex flex-1 flex-col items-center gap-1 overflow-y-auto px-1.5">
          <button
            className={`flex h-8 w-8 items-center justify-center rounded-[6px] transition-colors ${
              activeFolderId === null && !favoriteActive
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
            }`}
            onClick={() => onSelectFolder(null)}
            title={t("sidebarAllPhotos")}
          >
            <Folder className="h-4 w-4" />
          </button>

          {onSelectFavorites && (
            <button
              className={`flex h-8 w-8 items-center justify-center rounded-[6px] transition-colors ${
                favoriteActive
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
              }`}
              onClick={onSelectFavorites}
              title="收藏"
            >
              <Star className="h-4 w-4" />
            </button>
          )}

          {folders.map((folder) => (
            <button
              className={`flex h-8 w-8 items-center justify-center rounded-[6px] transition-colors ${
                activeFolderId === folder.id
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
              }`}
              key={folder.id}
              onClick={() => onSelectFolder(folder.id)}
              onContextMenu={(e) =>
                handleFolderContextMenu(e, folder.id, folder.displayName)
              }
              title={`${folder.displayName} (${folder.photoCount})\n右键删除`}
            >
              <Folder className="h-4 w-4" />
            </button>
          ))}

          {/* Tags popover — available when collapsed */}
          {tags.length > 0 && (
            <Popover open={tagPopoverOpen} onOpenChange={setTagPopoverOpen}>
              <PopoverTrigger asChild>
                <button
                  className={`flex h-8 w-8 items-center justify-center rounded-[6px] transition-colors ${
                    activeTagId
                      ? "bg-primary/15 text-primary"
                      : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                  }`}
                  title="标签"
                >
                  <Tag className="h-4 w-4" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                className="w-48 p-0"
                sideOffset={8}
              >
                <div className="max-h-[280px] overflow-y-auto p-1.5">
                  <p className="px-2 py-1 font-[510] text-muted-foreground/70 text-[10px] uppercase tracking-wider">
                    标签
                  </p>
                  {tags.map((tag) => (
                    <button
                      className={`flex w-full items-center gap-2 rounded-[6px] px-2 py-1 text-left text-[12px] transition-colors ${
                        activeTagId === tag.id
                          ? "bg-primary/15 text-primary"
                          : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                      }`}
                      key={tag.id}
                      onClick={() => {
                        const nextId = activeTagId === tag.id ? null : tag.id;
                        setActiveTagId(nextId);
                        onSelectTag?.(nextId);
                        setTagPopoverOpen(false);
                      }}
                    >
                      <span
                        className="h-2 w-2 flex-shrink-0 rounded-full"
                        style={{ background: tag.color || "var(--primary)" }}
                      />
                      <span className="truncate">{tag.name}</span>
                      <span className="ml-auto text-muted-foreground/70 text-[10px] tabular-nums">
                        {tag.photoCount}
                      </span>
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>

        <div className="flex flex-col items-center gap-1 px-1.5">
          <button
            className="flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:opacity-50"
            disabled={scanningFolder !== null}
            onClick={onAddFolder}
            title={t("sidebarAddFolder")}
          >
            {scanningFolder ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
          </button>

          <button
            className="flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            onClick={() => navigate({ to: "/dashboard" })}
            title={t("sidebarDashboard")}
          >
            <LayoutDashboard className="h-4 w-4" />
          </button>

          <button
            className="flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            onClick={() => navigate({ to: "/albums" as "/albums" })}
            title="相册"
          >
            <Album className="h-4 w-4" />
          </button>

          <button
            className="flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            onClick={() => navigate({ to: "/duplicates" })}
            title="重复照片检测"
          >
            <ScanSearch className="h-4 w-4" />
          </button>

          <button
            className="flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            onClick={() => navigate({ to: "/people" })}
            title="人物识别"
          >
            <Users className="h-4 w-4" />
          </button>

          <button
            className="flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            onClick={() => navigate({ to: "/trash" })}
            title="最近删除"
          >
            <Trash2 className="h-4 w-4" />
          </button>

          <button
            className="flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            onClick={() => navigate({ to: "/settings" })}
            title={t("sidebarSettings")}
          >
            <Settings className="h-4 w-4" />
          </button>

          <button
            className="flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            onClick={() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "?" }))}
            title="快捷键帮助 (?)"
          >
            <CircleHelp className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  // Expanded: full sidebar
  return (
    <div className="flex h-full w-[240px] select-none flex-col border-border border-r bg-secondary">
      {/* Header */}
      <div className="flex items-center justify-between border-border border-b px-4 py-3">
        <div>
          <h2 className="font-[590] text-[14px] text-foreground">
            {t("appName")}
          </h2>
          <p className="mt-0.5 text-muted-foreground/70 text-[11px]">
            {t("photosCount", { count: totalPhotos.toLocaleString() })}
          </p>
        </div>
        <button
          className="flex h-7 w-7 items-center justify-center rounded-[6px] text-muted-foreground/70 transition-colors hover:bg-foreground/5 hover:text-foreground"
          onClick={onToggleCollapse}
          title="折叠侧边栏"
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>

      {/* Quick Actions */}
      <div className="space-y-1 px-3 py-2">
        <button
          className={`w-full rounded-[6px] px-3 py-1.5 text-left text-[13px] transition-colors ${
            activeFolderId === null && !favoriteActive
              ? "bg-primary/15 text-primary"
              : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          }`}
          onClick={() => {
            setActiveTagId(null);
            onSelectTag?.(null);
            onSelectFolder(null);
          }}
        >
          {t("sidebarAllPhotos")}
        </button>
        {onSelectFavorites && (
          <button
            className={`flex w-full items-center gap-2 rounded-[6px] px-3 py-1.5 text-left text-[13px] transition-colors ${
              favoriteActive
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
            }`}
            onClick={onSelectFavorites}
          >
            <Star className="h-3.5 w-3.5" />
            收藏
          </button>
        )}
        <button
          className="flex w-full items-center gap-2 rounded-[6px] px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:opacity-50"
          disabled={scanningFolder !== null}
          onClick={onAddFolder}
        >
          {scanningFolder ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
          {t("sidebarAddFolder")}
        </button>
        <AiProgressBar />
      </div>

      {/* Scan progress */}
      {scanProgress && (
        <div className="px-3 py-1.5">
          <div className="rounded-[6px] bg-card px-3 py-2">
            <p className="text-[11px] text-muted-foreground">{scanProgress}</p>
            {scanningFolder && (
              <p className="mt-0.5 truncate text-muted-foreground/70 text-[10px]">
                {t("scanningPath", { path: scanningFolder })}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Separator */}
      <div className="mx-3 my-2 border-border border-t" />

      {/* Scrollable area: fills remaining space, pushes footer to bottom */}
      <div className="flex min-h-0 flex-1 flex-col px-3">
        {/* Folders */}
        <div className={`flex flex-col ${foldersCollapsed ? "" : "min-h-0 flex-1"}`}>
          <button
            className="flex w-full items-center gap-1 rounded-[4px] px-3 py-1 text-left transition-colors hover:bg-foreground/5"
            onClick={() => setFoldersCollapsed(!foldersCollapsed)}
          >
            <p className="flex-1 font-[510] text-muted-foreground/70 text-[11px] uppercase tracking-wider">
              {t("sidebarFolders")}
            </p>
            <ChevronDown
              className={`h-3 w-3 text-muted-foreground/70 transition-transform ${foldersCollapsed ? "-rotate-90" : "rotate-0"}`}
            />
          </button>
          {!foldersCollapsed && (
            <div className="flex-1 overflow-y-auto">
              {folderTree.length === 0 ? (
                <p className="px-3 py-2 text-muted-foreground/70 text-[12px]">
                  {t("sidebarNoFolders")}
                </p>
              ) : (
                renderFolderTree(
                  folderTree,
                  0,
                  expandedFolderIds,
                  (id) => {
                    const next = new Set(expandedFolderIds);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    setExpandedFolderIds(next);
                  },
                  activeFolderId,
                  onSelectFolder,
                  handleFolderContextMenu,
                )
              )}
            </div>
          )}
        </div>

        {/* Tags */}
        {(tags.length > 0 || totalPhotos > 0) && (
          <>
            <div className="mx-3 my-2 border-border border-t" />
            <div className={`flex flex-col ${tagsCollapsed ? "" : "min-h-0 flex-1"}`}>
              <button
                className="flex w-full items-center gap-1 rounded-[4px] px-3 py-1 text-left transition-colors hover:bg-foreground/5"
                onClick={() => setTagsCollapsed(!tagsCollapsed)}
              >
                <p className="flex-1 font-[510] text-muted-foreground/70 text-[11px] uppercase tracking-wider">
                  标签
                </p>
                <ChevronDown
                  className={`h-3 w-3 text-muted-foreground/70 transition-transform ${tagsCollapsed ? "-rotate-90" : "rotate-0"}`}
                />
              </button>
              {!tagsCollapsed && (
                <>
                  {tags.length > 0 ? (
                    <>
                      <div className="px-1 pb-1">
                        <input
                          className="w-full rounded-[4px] bg-card px-2 py-1 text-[11px] text-foreground outline-none placeholder:text-muted-foreground/70"
                          onChange={(e) => setTagSearch(e.target.value)}
                          placeholder="搜索标签..."
                          value={tagSearch}
                        />
                      </div>
                      <div className="flex-1 overflow-y-auto">
                        {tags
                          .filter((t) =>
                            tagSearch
                              ? t.name.toLowerCase().includes(tagSearch.toLowerCase())
                              : true
                          )
                          .map((tag) => (
                            <button
                              className={`group/tag flex w-full items-center gap-2 rounded-[6px] px-3 py-1 text-left text-[12px] transition-colors ${
                                dragOverTagId === tag.id
                                  ? "bg-primary/20 text-primary ring-1 ring-primary/50 animate-pulse"
                                  : activeTagId === tag.id
                                    ? "bg-primary/15 text-primary"
                                    : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                              }`}
                              key={tag.id}
                              onClick={() => {
                                const nextId = activeTagId === tag.id ? null : tag.id;
                                setActiveTagId(nextId);
                                onSelectTag?.(nextId);
                              }}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                setDeleteTagTarget({ id: tag.id, name: tag.name });
                              }}
                              onDragLeave={(e) => {
                                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                                  setDragOverTagId(null);
                                }
                              }}
                              onDragOver={handlePhotoDragOver}
                              onDragEnter={() => setDragOverTagId(tag.id)}
                              onDrop={(e) => handleDropOnTag(e, tag.id)}
                            >
                              <span
                                className="h-2 w-2 flex-shrink-0 rounded-full"
                                style={{ background: tag.color || "var(--primary)" }}
                              />
                              <span className="truncate">{tag.name}</span>
                              <span className="ml-auto text-muted-foreground/70 text-[10px] tabular-nums">
                                {tag.photoCount}
                              </span>
                            </button>
                          ))}
                      </div>
                    </>
                  ) : (
                    <div className="px-3 py-1">
                      <button
                        className="flex w-full items-center gap-1.5 rounded-[6px] border border-border px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
                        onClick={async () => {
                          try {
                            await ipc.client.photos.batchGenerateTags({});
                            const updated = await ipc.client.photos.getTags({});
                            setTags((updated as TagInfo[]) || []);
                            toast.success("AI 标签生成完成");
                          } catch {
                            toast.error("AI 标签生成失败");
                          }
                        }}
                      >
                        <ScanSearch className="h-3.5 w-3.5" />
                        批量生成 AI 标签
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>

      {/* Footer */}
      <div className="border-border border-t px-3 py-2">
        <button
          className="w-full rounded-[6px] px-3 py-1.5 text-left text-[13px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          onClick={() => navigate({ to: "/dashboard" })}
        >
          <LayoutDashboard className="mr-2 inline h-3.5 w-3.5" />
          {t("sidebarDashboard")}
        </button>
        <button
          className={`w-full rounded-[6px] px-3 py-1.5 text-left text-[13px] transition-colors ${
            dragOverAlbumNav
              ? "bg-primary/20 text-primary ring-1 ring-primary/50 animate-pulse"
              : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          }`}
          onDragEnter={() => setDragOverAlbumNav(true)}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              setDragOverAlbumNav(false);
            }
          }}
          onDragOver={handlePhotoDragOver}
          onDrop={handleDropOnAlbumNav}
          onClick={() => navigate({ to: "/albums" as "/albums" })}
        >
          <Album className="mr-2 inline h-3.5 w-3.5" />
          相册
          {dragOverAlbumNav && (
            <span className="ml-auto text-[10px] text-primary">松手添加</span>
          )}
        </button>
        <button
          className="w-full rounded-[6px] px-3 py-1.5 text-left text-[13px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          onClick={() => navigate({ to: "/duplicates" })}
        >
          <ScanSearch className="mr-2 inline h-3.5 w-3.5" />
          重复照片检测
        </button>
        <button
          className="w-full rounded-[6px] px-3 py-1.5 text-left text-[13px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          onClick={() => navigate({ to: "/people" })}
        >
          <Users className="mr-2 inline h-3.5 w-3.5" />
          人物识别
        </button>
        <button
          className="w-full rounded-[6px] px-3 py-1.5 text-left text-[13px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          onClick={() => navigate({ to: "/trash" })}
        >
          <Trash2 className="mr-2 inline h-3.5 w-3.5" />
          最近删除
        </button>
        <button
          className="w-full rounded-[6px] px-3 py-1.5 text-left text-[13px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          onClick={() => navigate({ to: "/settings" })}
        >
          <Settings className="mr-2 inline h-3.5 w-3.5" />
          {t("sidebarSettings")}
        </button>
        <button
          className="w-full rounded-[6px] px-3 py-1.5 text-left text-[13px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          onClick={() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "?" }))}
        >
          <CircleHelp className="mr-2 inline h-3.5 w-3.5" />
          快捷键帮助
        </button>
      </div>

      {/* Delete tag confirmation dialog */}
      <AlertDialog
        open={deleteTagTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTagTarget(null);
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>删除标签</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除标签「{deleteTagTarget?.name}」吗？该操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDeleteTag}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Folder context menu */}
      {folderCtx && (
        <div
          className="fixed z-[200] min-w-[140px] overflow-hidden rounded-[8px] border border-border bg-popover py-1 ring-1 ring-foreground/5"
          ref={ctxRef}
          style={{ left: folderCtx.x, top: folderCtx.y }}
        >
          <div className="truncate px-3 py-1 font-[510] text-muted-foreground/70 text-[10px] uppercase tracking-wider">
            {folderCtx.displayName}
          </div>
          <div className="mx-2 my-1 border-border border-t" />
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-destructive text-[13px] transition-colors hover:bg-destructive/10"
            onClick={() => {
              onDeleteFolder(folderCtx.folderId, folderCtx.displayName);
              closeCtx();
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            从索引中移除
          </button>
        </div>
      )}
    </div>
  );
}
