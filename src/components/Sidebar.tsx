import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  Album,
  ChevronDown,
  CircleHelp,
  Images,
  LayoutDashboard,
  Paintbrush,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  ScanSearch,
  Settings,
  Star,
  Swords,
  Tag,
  Trash2,
  Users,
  X,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAiStatus } from "@/hooks/useAiStatus";
import { ipc } from "@/ipc/manager";
import { getTagDisplayName } from "@/localization/tag-display";
import { queryClient } from "@/providers/QueryProvider";
import type { Folder as FolderType } from "@/types/photo";
import { FolderAppearanceDialog } from "./FolderAppearanceDialog";
import {
  buildFolderTree,
  buildTagTree,
  FolderTree,
  renderTagTree,
  type TagInfo,
} from "./sidebar-trees";

function SidebarTooltip({
  children,
  content,
}: {
  children: React.ReactElement;
  content: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right">{content}</TooltipContent>
    </Tooltip>
  );
}

function RailButton({
  active = false,
  badge = false,
  icon,
  label,
  onClick,
  onDragEnter,
  onDragLeave,
  onDragOver,
  onDrop,
}: {
  active?: boolean;
  badge?: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  onDragEnter?: React.DragEventHandler<HTMLButtonElement>;
  onDragLeave?: React.DragEventHandler<HTMLButtonElement>;
  onDragOver?: React.DragEventHandler<HTMLButtonElement>;
  onDrop?: React.DragEventHandler<HTMLButtonElement>;
}) {
  return (
    <SidebarTooltip content={label}>
      <button
        aria-label={label}
        className={`relative flex h-8 w-8 items-center justify-center rounded-[6px] transition-colors ${
          active
            ? "nav-item-active text-primary"
            : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
        }`}
        onClick={onClick}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
        type="button"
      >
        {icon}
        {badge && (
          <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-destructive ring-2 ring-sidebar" />
        )}
      </button>
    </SidebarTooltip>
  );
}

interface SidebarProps {
  activeFolderId: number | null;
  activeTagIds: number[];
  collapsed: boolean;
  favoriteActive?: boolean;
  folders: FolderType[];
  onAddFolder: (externalPath?: string) => void;
  onDeleteFolder: (id: number, displayName: string) => void;
  onSelectFavorites?: () => void;
  onSelectFolder: (id: number | null) => void;
  onToggleCollapse: () => void;
  onToggleTag?: (tagId: number | null) => void;
  onToggleTagMode?: () => void;
  tagMode: "and" | "or";
  totalPhotos: number;
}

export function Sidebar({
  folders,
  activeFolderId,
  activeTagIds,
  tagMode,
  collapsed,
  favoriteActive,
  onSelectFolder,
  onSelectFavorites,
  onAddFolder,
  onDeleteFolder,
  onToggleTag,
  onToggleTagMode,
  onToggleCollapse,
  totalPhotos,
}: SidebarProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [folderCtx, setFolderCtx] = useState<{
    folderId: number;
    displayName: string;
    x: number;
    y: number;
  } | null>(null);
  const [appearanceFolderId, setAppearanceFolderId] = useState<number | null>(
    null
  );
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [tagSearch, setTagSearch] = useState("");
  const [debouncedTagSearch, setDebouncedTagSearch] = useState("");
  const [trashCount, setTrashCount] = useState(0);

  useEffect(() => {
    const listDeletedPhotos = ipc.client.photos.listDeletedPhotos;
    if (typeof listDeletedPhotos === "function") {
      listDeletedPhotos({
        cursor: null,
        limit: 1,
        order: "desc",
        query: "",
        sort: "deletedAt",
      })
        .then((result) =>
          setTrashCount(result.trashTotalCount ?? result.totalCount)
        )
        .catch(() => undefined);
    }

    function handleTrashCount(event: Event) {
      setTrashCount((event as CustomEvent<number>).detail);
    }
    window.addEventListener("trash-count-changed", handleTrashCount);
    return () =>
      window.removeEventListener("trash-count-changed", handleTrashCount);
  }, []);
  const ctxRef = useRef<HTMLDivElement>(null);
  const [dragOverTagId, setDragOverTagId] = useState<number | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<number | null>(null);
  const [dragOverAlbumNav, setDragOverAlbumNav] = useState(false);
  const [foldersCollapsed, setFoldersCollapsed] = useState(false);
  const [tagsCollapsed, setTagsCollapsed] = useState(false);
  const [resourceView, setResourceView] = useState<"folders" | "tags">(
    "folders"
  );
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<number>>(
    new Set()
  );
  const [expandedTagIds, setExpandedTagIds] = useState<Set<number>>(new Set());
  const [deleteTagTarget, setDeleteTagTarget] = useState<{
    id: number;
    name: string;
  } | null>(null);
  const [tagCtx, setTagCtx] = useState<{
    tagId: number;
    tagName: string;
    x: number;
    y: number;
  } | null>(null);
  const [childTagParent, setChildTagParent] = useState<{
    parentId: number;
    parentName: string;
  } | null>(null);
  const [newChildTagName, setNewChildTagName] = useState("");
  const childInputRef = useRef<HTMLInputElement>(null);
  const childComposingRef = useRef(false);
  const [tagPopoverOpen, setTagPopoverOpen] = useState(false);
  const [batchTagLoading, setBatchTagLoading] = useState(false);
  const { data: aiStatus } = useAiStatus();
  const aiTagging = aiStatus?.embeddingProgress.phase === "tagging";
  const aiTagPipelineActive = Boolean(
    batchTagLoading || aiTagging || aiStatus?.isEmbedding
  );
  let aiTagStatusText = t("tagWaitingForIndex");
  if (batchTagLoading && !aiTagging) {
    aiTagStatusText = t("tagUpdating");
  } else if (aiTagging) {
    aiTagStatusText = t("tagGeneratingProgress", {
      processed: aiStatus?.embeddingProgress.processed ?? 0,
      total: aiStatus?.embeddingProgress.total ?? 0,
    });
  }

  async function handleBatchGenerateTags() {
    if (batchTagLoading || aiTagPipelineActive) {
      return;
    }
    setBatchTagLoading(true);
    try {
      const result = (await ipc.client.photos.batchGenerateTags({})) as {
        busy?: boolean;
      };
      if (result.busy) {
        return;
      }
      const updated = await ipc.client.photos.getTags({
        folderId: activeFolderId ?? undefined,
      });
      setTags((updated as TagInfo[]) || []);
      toast.success(t("aiTagsGenerated"));
    } catch {
      toast.error(t("aiTagsFailed"));
    } finally {
      setBatchTagLoading(false);
    }
  }

  // Debounce tag search to avoid rebuilding the tree on every keystroke
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedTagSearch(tagSearch), 150);
    return () => clearTimeout(timer);
  }, [tagSearch]);

  // Auto-expand parent nodes during tag search so matching children are visible
  const preSearchExpandedRef = useRef<Set<number> | null>(null);
  useEffect(() => {
    if (debouncedTagSearch) {
      // Save current expand state before modifying it (only on first keystroke)
      if (preSearchExpandedRef.current === null) {
        preSearchExpandedRef.current = new Set(expandedTagIds);
      }
      // Find all ancestors of matching tags and auto-expand them
      const matchingIds = new Set(
        tags
          .filter((t) =>
            t.name.toLowerCase().includes(debouncedTagSearch.toLowerCase())
          )
          .map((t) => t.id)
      );
      const tagMap = new Map(tags.map((t) => [t.id, t]));
      const ancestorsToExpand = new Set<number>();
      for (const id of matchingIds) {
        let cur = tagMap.get(id)?.parentId ?? null;
        while (cur) {
          if (ancestorsToExpand.has(cur)) {
            break;
          }
          ancestorsToExpand.add(cur);
          cur = tagMap.get(cur)?.parentId ?? null;
        }
      }
      if (ancestorsToExpand.size > 0) {
        setExpandedTagIds((prev) => {
          const next = new Set(prev);
          for (const id of ancestorsToExpand) {
            next.add(id);
          }
          return next;
        });
      }
    } else {
      // Search cleared — restore previous expand state
      if (preSearchExpandedRef.current !== null) {
        setExpandedTagIds(preSearchExpandedRef.current);
        preSearchExpandedRef.current = null;
      }
    }
  }, [debouncedTagSearch, tags]);

  // Drag-and-drop: album/tag/folder drop targets + external folder import
  function handleSidebarDragOver(e: React.DragEvent) {
    if (e.dataTransfer.types.includes("application/x-photo-ids")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    } else if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }

  async function handleSidebarDrop(e: React.DragEvent) {
    // External folder drop → import
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      const items = Array.from(e.dataTransfer.items);
      const folders: string[] = [];
      for (const item of items) {
        if (item.kind !== "file") {
          continue;
        }
        const entry = item.webkitGetAsEntry?.();
        const file = item.getAsFile();
        if (!file) {
          continue;
        }
        const filePath = (window as any).electronAPI?.getFilePath?.(file);
        if (!filePath) {
          continue;
        }
        if (entry?.isDirectory) {
          folders.push(filePath);
        } else {
          const parent = filePath.replace(/[\\/][^\\/]+$/, "");
          if (parent && !folders.includes(parent)) {
            folders.push(parent);
          }
        }
      }
      for (const folder of folders) {
        onAddFolder(folder);
      }
    }
  }

  function handleFolderDragOver(e: React.DragEvent, folderId: number) {
    if (e.dataTransfer.types.includes("application/x-photo-ids")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDragOverFolderId(folderId);
    }
  }

  function handleFolderDragLeave() {
    setDragOverFolderId(null);
  }

  async function handleFolderDrop(e: React.DragEvent, folderId: number) {
    setDragOverFolderId(null);
    const raw = e.dataTransfer.getData("application/x-photo-ids");
    if (!raw) {
      return;
    }
    const ids: number[] = JSON.parse(raw);
    if (ids.length === 0) {
      return;
    }
    try {
      const result = (await ipc.client.photos.movePhotos({
        ids,
        targetFolderId: folderId,
      })) as { moved: number };
      if (result.moved > 0) {
        toast.success(t("photosMoved", { count: result.moved }));
        queryClient.invalidateQueries({
          queryKey: ["photos"],
          refetchType: "active",
        });
        queryClient.invalidateQueries({ queryKey: ["folders"] });
      }
    } catch {
      toast.error(t("movePhotosFailed"));
    }
  }

  async function handleDropOnTag(e: React.DragEvent, tagId: number) {
    setDragOverTagId(null);
    const raw = e.dataTransfer.getData("application/x-photo-ids");
    if (!raw) {
      return;
    }
    const ids: number[] = JSON.parse(raw);
    const tag = tags.find((t) => t.id === tagId);
    let failed = 0;
    for (const photoId of ids) {
      try {
        await ipc.client.photos.setPhotoTag({ photoId, tagId });
      } catch (err) {
        console.error("[handleDropOnTag] failed to add tag to photo:", err);
        failed++;
      }
    }
    queryClient.invalidateQueries({
      queryKey: ["photos"],
      refetchType: "active",
    });
    // Refresh tag counts
    try {
      const updated = await ipc.client.photos.getTags({
        folderId: activeFolderId ?? undefined,
      });
      setTags((updated as TagInfo[]) || []);
    } catch (err) {
      console.error("[handleDropOnTag] failed to refresh tags:", err);
    }
    const displayName = tag?.name
      ? getTagDisplayName(tag.name, i18n.language)
      : "";
    if (failed > 0) {
      toast.success(
        t("tagAddedToPhotos", {
          count: ids.length - failed,
          name: displayName,
        })
      );
    } else {
      toast.success(
        t("tagAddedToPhotos", { count: ids.length, name: displayName })
      );
    }
  }

  async function handleDropOnAlbumNav(e: React.DragEvent) {
    setDragOverAlbumNav(false);
    const raw = e.dataTransfer.getData("application/x-photo-ids");
    if (!raw) {
      return;
    }
    const ids: number[] = JSON.parse(raw);
    // Open AddToAlbumDialog — for now navigate to albums page as fallback
    // Dispatch a custom event so the parent can intercept it
    window.dispatchEvent(
      new CustomEvent("photo-drop:album", { detail: { photoIds: ids } })
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
        if (!running) {
          return;
        }
        const tagList = (result as TagInfo[]) || [];
        setTags(tagList);
        // Clear active tags that are no longer in the filtered list
        if (
          activeTagIds.length > 0 &&
          activeTagIds.some((id) => !tagList.some((t) => t.id === id))
        ) {
          for (const id of activeTagIds) {
            if (!tagList.some((t) => t.id === id)) {
              onToggleTag?.(id);
            }
          }
        }
        // Stop polling once tags appear
        if (tagList.length > 0 && interval) {
          clearInterval(interval);
          interval = null;
        }
      } catch (err) {
        console.error("[Sidebar loadTags] failed:", err);
      }
    }

    loadTags();
    // Poll for tags if photos exist but tags haven't loaded yet
    if (totalPhotos > 0) {
      interval = setInterval(loadTags, 5000);
    }

    return () => {
      running = false;
      if (interval) {
        clearInterval(interval);
      }
    };
  }, [totalPhotos, activeFolderId, activeTagIds, onToggleTag]);

  useEffect(() => {
    function handler(event: MessageEvent) {
      if (
        event.data?.channel === "ai-embedding-done" ||
        event.data?.channel === "ai-tags-done"
      ) {
        queryClient.invalidateQueries({ queryKey: ["aiStatus"] });
        ipc.client.photos
          .getTags({ folderId: activeFolderId ?? undefined })
          .then((updated) => setTags((updated as TagInfo[]) || []))
          .catch(() => {
            /* ignore */
          });
      }
    }
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [activeFolderId]);

  // Listen for tag changes from other components (e.g. PhotoDetailPanel)
  useEffect(() => {
    function handleTagsChanged() {
      ipc.client.photos
        .getTags({
          folderId: activeFolderId ?? undefined,
        })
        .then((updated) => {
          setTags((updated as TagInfo[]) || []);
        })
        .catch(() => {
          /* ignore */
        });
    }
    window.addEventListener("tags-changed", handleTagsChanged);
    return () => window.removeEventListener("tags-changed", handleTagsChanged);
  }, [activeFolderId]);

  const closeCtx = useCallback(() => setFolderCtx(null), []);

  // Keyboard navigation handler for tag tree
  function handleTagTreeKeyDown(
    e: React.KeyboardEvent,
    expandedIds: Set<number>,
    setExpandedIds: (next: Set<number>) => void,
    onTagToggle: ((tagId: number | null) => void) | undefined,
    setSearch: (v: string) => void,
    setDebouncedSearch: (v: string) => void
  ) {
    const currentFocus = document.activeElement as HTMLElement;
    const treeContainer = e.currentTarget as HTMLElement;
    const allItems = Array.from(
      treeContainer.querySelectorAll('[role="treeitem"]')
    ) as HTMLElement[];
    if (allItems.length === 0) {
      return;
    }

    let currentIndex = allItems.indexOf(currentFocus);
    // If focus is not on any treeitem (e.g. on the search input),
    // default to the first visible item
    if (currentIndex === -1) {
      currentIndex = 0;
    }

    switch (e.key) {
      case "ArrowDown": {
        e.preventDefault();
        const next = allItems[Math.min(currentIndex + 1, allItems.length - 1)];
        if (next) {
          for (const item of allItems) {
            item.setAttribute("tabindex", "-1");
          }
          next.setAttribute("tabindex", "0");
          next.focus();
        }
        break;
      }
      case "ArrowUp": {
        e.preventDefault();
        const prev = allItems[Math.max(currentIndex - 1, 0)];
        if (prev) {
          for (const item of allItems) {
            item.setAttribute("tabindex", "-1");
          }
          prev.setAttribute("tabindex", "0");
          prev.focus();
        }
        break;
      }
      case "ArrowRight": {
        e.preventDefault();
        const currentId = Number(currentFocus?.getAttribute("data-tag-id"));
        if (currentId && !expandedIds.has(currentId)) {
          const tag = tags.find((t) => t.id === currentId);
          if (tag && tags.some((t) => t.parentId === currentId)) {
            const next = new Set(expandedIds);
            next.add(currentId);
            setExpandedIds(next);
          }
        }
        break;
      }
      case "ArrowLeft": {
        e.preventDefault();
        const curId = Number(currentFocus?.getAttribute("data-tag-id"));
        if (curId && expandedIds.has(curId)) {
          const nxt = new Set(expandedIds);
          nxt.delete(curId);
          setExpandedIds(nxt);
        }
        break;
      }
      case "Enter":
      case " ": {
        e.preventDefault();
        const id = Number(currentFocus?.getAttribute("data-tag-id"));
        if (id && !Number.isNaN(id)) {
          onTagToggle?.(id);
        }
        break;
      }
      case "Escape": {
        e.preventDefault();
        setSearch("");
        setDebouncedSearch("");
        treeContainer.focus();
        break;
      }
      case "/":
      case "f": {
        // Ctrl+F or / key: focus search input
        if (e.key === "f" && !e.ctrlKey && !e.metaKey) {
          break;
        }
        e.preventDefault();
        const input = treeContainer
          .closest(".flex.flex-col, .p-1\\.5")
          ?.querySelector('input[role="searchbox"]') as HTMLInputElement | null;
        input?.focus();
        input?.select();
        break;
      }
    }
  }

  async function handleCreateChildTag() {
    const name = newChildTagName.trim();
    if (!(name && childTagParent)) {
      return;
    }
    const { parentId, parentName } = childTagParent;
    setChildTagParent(null);
    setNewChildTagName("");
    try {
      await ipc.client.photos.addTag({
        name,
        color: undefined,
        parentId,
      });
      const updated = await ipc.client.photos.getTags({
        folderId: activeFolderId ?? undefined,
      });
      setTags((updated as TagInfo[]) || []);
      // Auto-expand parent
      setExpandedTagIds((prev) => new Set(prev).add(parentId));
      queryClient.invalidateQueries({
        queryKey: ["photos"],
        refetchType: "active",
      });
      toast.success(t("childTagCreated", { name, parent: parentName }));
    } catch {
      toast.error(t("createChildTagFailed"));
    }
  }

  async function handleDeleteTag() {
    if (!deleteTagTarget) {
      return;
    }
    const { id, name } = deleteTagTarget;
    setDeleteTagTarget(null);
    try {
      await ipc.client.photos.deleteTag({ id });
      const updated = await ipc.client.photos.getTags({
        folderId: activeFolderId ?? undefined,
      });
      setTags((updated as TagInfo[]) || []);
      if (activeTagIds.includes(id)) {
        onToggleTag?.(id);
      }
      toast.success(t("tagDeleted", { name }));
    } catch {
      toast.error(t("deleteTagFailed"));
    }
  }

  useEffect(() => {
    if (!(folderCtx || tagCtx)) {
      return;
    }
    function handleClick(e: MouseEvent) {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) {
        closeCtx();
        setTagCtx(null);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        closeCtx();
        setTagCtx(null);
      }
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [folderCtx, tagCtx, closeCtx]);

  // Global keyboard shortcut: [ toggles sidebar collapse
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "[" && !e.ctrlKey && !e.metaKey) {
        const target = e.target as HTMLElement;
        if (
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable
        ) {
          return;
        }
        e.preventDefault();
        onToggleCollapse();
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onToggleCollapse]);

  const folderTree = useMemo(() => buildFolderTree(folders), [folders]);
  const appearanceFolder =
    folders.find((folder) => folder.id === appearanceFolderId) ?? null;
  // Auto-expand each root parent once without overwriting the user's choices.
  const autoExpandedFolderIdsRef = useRef(new Set<number>());
  useEffect(() => {
    const newRootParents = folderTree
      .filter(
        (node) =>
          node.children.length > 0 &&
          !autoExpandedFolderIdsRef.current.has(node.folder.id)
      )
      .map((node) => node.folder.id);
    if (newRootParents.length === 0) {
      return;
    }

    for (const id of newRootParents) {
      autoExpandedFolderIdsRef.current.add(id);
    }
    setExpandedFolderIds((previous) => {
      const next = new Set(previous);
      for (const id of newRootParents) {
        next.add(id);
      }
      return next;
    });
  }, [folderTree]);

  function handleFolderContextMenu(
    e: React.MouseEvent,
    folderId: number,
    displayName: string
  ) {
    e.preventDefault();
    setFolderCtx({ folderId, displayName, x: e.clientX, y: e.clientY });
  }

  // Collapsed: icon-only bar

  return (
    <>
      <div
        className={`sidebar-bg flex h-full flex-row overflow-hidden ${
          collapsed ? "w-12" : "w-[calc(48px+clamp(240px,20vw,300px))]"
        }`}
        onDragOver={handleSidebarDragOver}
        onDrop={handleSidebarDrop}
      >
        <nav
          aria-label={t("appName")}
          className="sidebar-rail flex h-full w-12 flex-shrink-0 flex-col items-center border-foreground/8 border-r py-2"
        >
          <SidebarTooltip
            content={collapsed ? t("expandSidebar") : t("collapseSidebar")}
          >
            <button
              aria-label={collapsed ? t("expandSidebar") : t("collapseSidebar")}
              className="mb-2 flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground/70 transition-colors hover:bg-foreground/5 hover:text-foreground"
              onClick={onToggleCollapse}
              type="button"
            >
              {collapsed ? (
                <PanelLeftOpen className="h-4 w-4" />
              ) : (
                <PanelLeftClose className="h-4 w-4" />
              )}
            </button>
          </SidebarTooltip>

          <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto px-1.5">
            <RailButton
              active={location.pathname === "/"}
              icon={<Images className="h-4 w-4" />}
              label={t("sidebarAllPhotos")}
              onClick={() => {
                if (collapsed) {
                  onToggleCollapse();
                } else {
                  onToggleTag?.(null);
                  onSelectFolder(null);
                }
              }}
            />
            <RailButton
              active={location.pathname === "/dashboard"}
              icon={<LayoutDashboard className="h-4 w-4" />}
              label={t("sidebarDashboard")}
              onClick={() => navigate({ to: "/dashboard" })}
            />
            <RailButton
              active={
                dragOverAlbumNav || location.pathname.startsWith("/albums")
              }
              icon={<Album className="h-4 w-4" />}
              label={t("sidebarAlbums")}
              onClick={() => navigate({ to: "/albums" as const })}
              onDragEnter={() => setDragOverAlbumNav(true)}
              onDragLeave={(event) => {
                if (
                  !event.currentTarget.contains(event.relatedTarget as Node)
                ) {
                  setDragOverAlbumNav(false);
                }
              }}
              onDragOver={handleSidebarDragOver}
              onDrop={handleDropOnAlbumNav}
            />
            <RailButton
              active={location.pathname === "/people"}
              icon={<Users className="h-4 w-4" />}
              label={t("people")}
              onClick={() => navigate({ to: "/people" })}
            />

            <div className="my-1 h-px w-6 bg-foreground/8" />

            <RailButton
              active={location.pathname === "/duplicates"}
              icon={<ScanSearch className="h-4 w-4" />}
              label={t("duplicates")}
              onClick={() => navigate({ to: "/duplicates" })}
            />
            <RailButton
              active={location.pathname.startsWith("/cull")}
              icon={<Swords className="h-4 w-4" />}
              label={t("cull")}
              onClick={() => navigate({ to: "/cull" })}
            />
            <RailButton
              active={location.pathname === "/trash"}
              badge={trashCount > 0}
              icon={<Trash2 className="h-4 w-4" />}
              label={t("trash")}
              onClick={() => navigate({ to: "/trash" })}
            />
          </div>

          <div className="flex flex-col items-center gap-1 px-1.5">
            <RailButton
              active={location.pathname.startsWith("/settings")}
              icon={<Settings className="h-4 w-4" />}
              label={t("sidebarSettings")}
              onClick={() => navigate({ to: "/settings" })}
            />
            <RailButton
              icon={<CircleHelp className="h-4 w-4" />}
              label={t("keyboardHelpTitle")}
              onClick={() =>
                document.dispatchEvent(
                  new KeyboardEvent("keydown", { key: "?" })
                )
              }
            />
          </div>
        </nav>

        {!collapsed && (
          <div className="flex h-full w-[clamp(240px,20vw,300px)] select-none flex-col">
            {/* Header */}
            <div className="flex items-center gap-2 px-4 py-3">
              <Images className="h-4 w-4 text-primary" />
              <div className="min-w-0">
                <p className="font-semibold text-[13px] text-foreground">
                  {t("sidebarAllPhotos")}
                </p>
                <p className="text-[10px] text-muted-foreground/70 tabular-nums">
                  {t("photosCount", { count: totalPhotos.toLocaleString() })}
                </p>
              </div>
            </div>

            {/* Separator */}
            <div className="mx-3 border-border border-t" />

            {/* Content area — dual flex-1 sections */}
            <div className="flex min-h-0 flex-1 flex-col px-3 pt-2">
              {/* All Photos + Favorites — content filters */}
              <button
                className={`flex w-full items-center gap-2 rounded-[6px] px-3 py-1.5 text-left text-[13px] transition-colors ${
                  activeFolderId === null && !favoriteActive
                    ? "nav-item-active bg-primary/15 text-primary"
                    : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                }`}
                onClick={() => {
                  onToggleTag?.(null);
                  onSelectFolder(null);
                }}
              >
                <Images className="h-3.5 w-3.5" />
                {t("sidebarAllPhotos")}
              </button>
              {onSelectFavorites && (
                <button
                  className={`flex w-full items-center gap-2 rounded-[6px] px-3 py-1.5 text-left text-[13px] transition-colors ${
                    favoriteActive
                      ? "nav-item-active bg-primary/15 text-primary"
                      : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                  }`}
                  onClick={() => {
                    if (favoriteActive) {
                      return;
                    }
                    onSelectFavorites?.();
                  }}
                >
                  <Star className="h-3.5 w-3.5" />
                  {t("favorite")}
                </button>
              )}

              <div className="my-2 border-border border-t" />

              <div className="mb-2 grid grid-cols-2 rounded-[6px] bg-foreground/5 p-0.5">
                <button
                  aria-pressed={resourceView === "folders"}
                  className={`rounded-[5px] px-2 py-1 text-[11px] transition-colors ${
                    resourceView === "folders"
                      ? "bg-card text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => setResourceView("folders")}
                  type="button"
                >
                  {t("sidebarFolders")}
                </button>
                <button
                  aria-pressed={resourceView === "tags"}
                  className={`rounded-[5px] px-2 py-1 text-[11px] transition-colors ${
                    resourceView === "tags"
                      ? "bg-card text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => setResourceView("tags")}
                  type="button"
                >
                  {t("sidebarTags")}
                </button>
              </div>

              {/* Folders */}
              <div
                className={`${resourceView === "folders" ? "flex" : "hidden"} flex-col ${foldersCollapsed ? "" : "min-h-0 flex-1"}`}
              >
                <div className="flex w-full items-center gap-1 rounded-[4px] px-3 py-1 transition-colors hover:bg-foreground/5">
                  <button
                    className="flex flex-1 items-center gap-1 text-left"
                    onClick={() => setFoldersCollapsed((v) => !v)}
                  >
                    <p
                      className={`flex-1 font-medium text-[11px] uppercase ${i18n.language === "zh" ? "tracking-normal" : "tracking-wider"} text-muted-foreground/70`}
                    >
                      {t("sidebarFolders")}
                    </p>
                    <ChevronDown
                      className={`h-3 w-3 text-muted-foreground/70 transition-transform ${foldersCollapsed ? "-rotate-90" : "rotate-0"}`}
                    />
                  </button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        aria-label={t("sidebarAddFolder")}
                        className="flex h-5 w-5 items-center justify-center rounded-[4px] text-muted-foreground/70 hover:text-foreground disabled:opacity-50"
                        onClick={(e) => {
                          e.stopPropagation();
                          onAddFolder();
                        }}
                        type="button"
                      >
                        <Plus className="h-3 w-3" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{t("sidebarAddFolder")}</TooltipContent>
                  </Tooltip>
                </div>
                {!foldersCollapsed && (
                  <div className="flex min-h-0 flex-1 flex-col">
                    {folderTree.length === 0 ? (
                      <p className="px-3 py-2 text-[12px] text-muted-foreground/70">
                        {t("sidebarNoFolders")}
                      </p>
                    ) : (
                      <FolderTree
                        activeId={activeFolderId}
                        dragOverId={dragOverFolderId}
                        expandedIds={expandedFolderIds}
                        label={t("sidebarFolders")}
                        nodes={folderTree}
                        onContextMenu={handleFolderContextMenu}
                        onDragLeave={handleFolderDragLeave}
                        onDragOver={handleFolderDragOver}
                        onDrop={handleFolderDrop}
                        onSelect={onSelectFolder}
                        onToggle={(id) => {
                          const next = new Set(expandedFolderIds);
                          if (next.has(id)) {
                            next.delete(id);
                          } else {
                            next.add(id);
                          }
                          setExpandedFolderIds(next);
                        }}
                      />
                    )}
                  </div>
                )}
              </div>

              {/* Tags */}
              {resourceView === "tags" &&
                (tags.length > 0 || totalPhotos > 0) && (
                  <>
                    <div className="mx-3 my-2 border-border border-t" />
                    <div
                      className={`flex flex-col ${tagsCollapsed ? "" : "min-h-0 flex-1"}`}
                    >
                      <button
                        className="flex w-full items-center gap-1 rounded-[4px] px-3 py-1 text-left transition-colors hover:bg-foreground/5"
                        onClick={() => setTagsCollapsed((v) => !v)}
                      >
                        <p
                          className={`flex-1 font-medium text-[11px] uppercase ${i18n.language === "zh" ? "tracking-normal" : "tracking-wider"} text-muted-foreground/70`}
                        >
                          {t("sidebarTags")}
                        </p>
                        <ChevronDown
                          className={`h-3 w-3 text-muted-foreground/70 transition-transform ${tagsCollapsed ? "-rotate-90" : "rotate-0"}`}
                        />
                      </button>
                      {!tagsCollapsed &&
                        aiTagPipelineActive &&
                        tags.some((tag) => tag.photoCount > 0) && (
                          <div className="flex items-center gap-1 px-3 py-1 text-[10px] text-primary/80">
                            <ScanSearch className="h-3 w-3 animate-pulse" />
                            {aiTagging ? aiTagStatusText : t("tagUpdating")}
                          </div>
                        )}
                      {!tagsCollapsed &&
                        (tags.length > 0 ? (
                          <>
                            {/* Active tag chips */}
                            {activeTagIds.length > 0 && (
                              <div className="flex flex-wrap gap-1 px-1 pb-1">
                                {activeTagIds.slice(0, 3).map((id) => {
                                  const tag = tags.find((t) => t.id === id);
                                  return (
                                    <span
                                      className="inline-flex items-center gap-1 rounded-[4px] border border-primary/20 bg-primary/10 px-1.5 py-0.5 text-[10px]"
                                      key={id}
                                    >
                                      <span
                                        className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full"
                                        style={{
                                          backgroundColor: tag?.color ?? "#888",
                                        }}
                                      />
                                      <span className="max-w-[90px] truncate">
                                        {getTagDisplayName(
                                          tag?.name ?? "",
                                          i18n.language
                                        )}
                                      </span>
                                      <button
                                        aria-label={
                                          t("clickToRemove") +
                                          " " +
                                          getTagDisplayName(
                                            tag?.name ?? "",
                                            i18n.language
                                          )
                                        }
                                        className="ml-0.5 flex h-3 w-3 items-center justify-center rounded-[3px] text-muted-foreground/70 hover:text-foreground"
                                        onClick={() => onToggleTag?.(id)}
                                        type="button"
                                      >
                                        <X className="h-2 w-2" />
                                      </button>
                                    </span>
                                  );
                                })}
                                {activeTagIds.length > 3 && (
                                  <span className="inline-flex items-center rounded-[4px] border border-primary/20 bg-primary/10 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                    {t("andMore", {
                                      count: activeTagIds.length - 3,
                                    })}
                                  </span>
                                )}
                              </div>
                            )}
                            {activeTagIds.length >= 2 && onToggleTagMode && (
                              <div className="flex items-center justify-between px-1 pb-1">
                                <span className="text-[10px] text-muted-foreground/70">
                                  {t("tagFilterMode")}
                                </span>
                                <button
                                  aria-label={t("tagFilterMode")}
                                  aria-pressed={tagMode === "and"}
                                  className="rounded-[3px] border border-border px-1.5 py-0 font-medium text-[10px] text-primary transition-colors hover:bg-primary/10"
                                  onClick={onToggleTagMode}
                                  type="button"
                                >
                                  {tagMode.toUpperCase()}
                                </button>
                              </div>
                            )}
                            <div className="px-1 pb-1">
                              <div className="relative">
                                <input
                                  aria-label={t("tagSearchPlaceholder")}
                                  className="w-full rounded-[4px] bg-card py-1 pr-6 pl-2 text-[11px] text-foreground outline-none placeholder:text-muted-foreground/70"
                                  onChange={(e) => setTagSearch(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Escape") {
                                      e.preventDefault();
                                      setTagSearch("");
                                      setDebouncedTagSearch("");
                                      const tree = (
                                        e.currentTarget as HTMLElement
                                      ).closest(
                                        '[role="tree"]'
                                      ) as HTMLElement | null;
                                      tree?.focus();
                                    }
                                  }}
                                  placeholder={t("tagSearchPlaceholder")}
                                  role="searchbox"
                                  value={tagSearch}
                                />
                                {tagSearch && (
                                  <button
                                    className="absolute top-1/2 right-1.5 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-[3px] text-muted-foreground/70 hover:text-foreground"
                                    onClick={() => {
                                      setTagSearch("");
                                      setDebouncedTagSearch("");
                                    }}
                                    type="button"
                                  >
                                    <X className="h-3 w-3" />
                                  </button>
                                )}
                              </div>
                            </div>
                            <div
                              aria-label={t("sidebarTags")}
                              className="flex-1 overflow-y-auto"
                              onFocus={(e) => {
                                const container = e.currentTarget;
                                const currentFocus = document.activeElement;
                                if (
                                  currentFocus === container ||
                                  !container.contains(currentFocus)
                                ) {
                                  const first = container.querySelector(
                                    '[role="treeitem"]'
                                  ) as HTMLElement | null;
                                  if (first) {
                                    const items =
                                      container.querySelectorAll(
                                        '[role="treeitem"]'
                                      );
                                    for (const item of items) {
                                      (item as HTMLElement).setAttribute(
                                        "tabindex",
                                        "-1"
                                      );
                                    }
                                    first.setAttribute("tabindex", "0");
                                    first.focus();
                                  }
                                }
                              }}
                              onKeyDown={(e) => {
                                handleTagTreeKeyDown(
                                  e,
                                  expandedTagIds,
                                  setExpandedTagIds,
                                  onToggleTag,
                                  setTagSearch,
                                  setDebouncedTagSearch
                                );
                              }}
                              role="tree"
                              tabIndex={0}
                            >
                              {(() => {
                                const filtered = tags.filter((t) =>
                                  debouncedTagSearch
                                    ? t.name
                                        .toLowerCase()
                                        .includes(
                                          debouncedTagSearch.toLowerCase()
                                        )
                                    : true
                                );
                                const allIds = new Set(
                                  filtered.map((t) => t.id)
                                );
                                for (const t of filtered) {
                                  let cur: number | null = t.parentId;
                                  while (cur !== null) {
                                    const currentId = cur;
                                    if (allIds.has(currentId)) {
                                      break;
                                    }
                                    const parent = tags.find(
                                      (p) => p.id === currentId
                                    );
                                    if (parent) {
                                      allIds.add(cur);
                                      cur = parent.parentId;
                                    } else {
                                      break;
                                    }
                                  }
                                }
                                const visible = tags.filter((t) =>
                                  allIds.has(t.id)
                                );
                                const tree = buildTagTree(visible);
                                return renderTagTree(
                                  tree,
                                  0,
                                  expandedTagIds,
                                  (id) => {
                                    const next = new Set(expandedTagIds);
                                    if (next.has(id)) {
                                      next.delete(id);
                                    } else {
                                      next.add(id);
                                    }
                                    setExpandedTagIds(next);
                                  },
                                  activeTagIds,
                                  (nextId) => {
                                    if (nextId !== null) {
                                      onToggleTag?.(nextId);
                                    }
                                  },
                                  (e, id, name) => {
                                    e.preventDefault();
                                    setTagCtx({
                                      tagId: id,
                                      tagName: name,
                                      x: e.clientX,
                                      y: e.clientY,
                                    });
                                  },
                                  handleSidebarDragOver,
                                  (id) => setDragOverTagId(id),
                                  (e) => {
                                    if (
                                      !(
                                        e.currentTarget as HTMLElement
                                      ).contains(e.relatedTarget as Node)
                                    ) {
                                      setDragOverTagId(null);
                                    }
                                  },
                                  (e, id) => handleDropOnTag(e, id),
                                  dragOverTagId,
                                  i18n.language
                                );
                              })()}
                            </div>
                            {!tags.some((t) => t.photoCount > 0) && (
                              <div className="px-1 py-1">
                                {aiTagPipelineActive ? (
                                  <div className="flex items-center gap-1.5 rounded-[6px] border border-primary/20 bg-primary/5 px-2 py-1.5 text-[11px] text-primary">
                                    <ScanSearch className="h-3.5 w-3.5 animate-pulse" />
                                    {aiTagStatusText}
                                  </div>
                                ) : (
                                  <button
                                    className="flex w-full items-center justify-center gap-1.5 rounded-[6px] border border-primary/30 bg-primary/10 px-2 py-1.5 text-[11px] text-primary transition-colors hover:bg-primary/20 disabled:opacity-60"
                                    disabled={batchTagLoading}
                                    onClick={handleBatchGenerateTags}
                                    type="button"
                                  >
                                    <ScanSearch className="h-3.5 w-3.5" />
                                    {t("tagBatchGenerate")}
                                  </button>
                                )}
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="px-3 py-1">
                            {aiTagPipelineActive ? (
                              <div className="flex items-center gap-1.5 rounded-[6px] border border-primary/20 bg-primary/5 px-2 py-1.5 text-[11px] text-primary">
                                <ScanSearch className="h-3.5 w-3.5 animate-pulse" />
                                {aiTagStatusText}
                              </div>
                            ) : (
                              <button
                                className="flex w-full items-center gap-1.5 rounded-[6px] border border-border px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary disabled:opacity-60"
                                disabled={batchTagLoading}
                                onClick={handleBatchGenerateTags}
                                type="button"
                              >
                                <ScanSearch className="h-3.5 w-3.5" />
                                {t("tagBatchGenerate")}
                              </button>
                            )}
                          </div>
                        ))}
                      <p className="mt-1 px-1 text-[10px] text-muted-foreground/40">
                        {t("aiTagDisclaimer")}
                      </p>
                    </div>
                  </>
                )}
            </div>
          </div>
        )}
      </div>

      {/* Delete tag confirmation dialog */}
      <ConfirmDialog
        confirmText={t("delete")}
        description={t("tagDeleteDescription", {
          name: deleteTagTarget
            ? getTagDisplayName(deleteTagTarget.name, i18n.language)
            : "",
        })}
        destructive
        onCancel={() => setDeleteTagTarget(null)}
        onConfirm={handleDeleteTag}
        open={deleteTagTarget !== null}
        title={t("tagDeleteTitle")}
      />

      {/* Folder context menu */}
      {folderCtx && (
        <div
          className="fixed z-[200] min-w-[140px] animate-context-menu-enter overflow-hidden rounded-[8px] border border-border bg-popover py-1 ring-1 ring-foreground/5"
          ref={ctxRef}
          style={{
            left: Math.min(folderCtx.x, window.innerWidth - 160),
            top: Math.min(folderCtx.y, window.innerHeight - 140),
          }}
        >
          <div className="truncate px-3 py-1 font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider">
            {folderCtx.displayName}
          </div>
          <div className="mx-2 my-1 border-border border-t" />
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-foreground/5"
            onClick={() => {
              setAppearanceFolderId(folderCtx.folderId);
              closeCtx();
            }}
            type="button"
          >
            <Paintbrush className="h-3.5 w-3.5" />
            {t("customizeFolderAppearance")}
          </button>
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-destructive transition-colors hover:bg-destructive/10"
            onClick={() => {
              onDeleteFolder(folderCtx.folderId, folderCtx.displayName);
              closeCtx();
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t("removeFromIndex")}
          </button>
        </div>
      )}

      <FolderAppearanceDialog
        folder={appearanceFolder}
        onOpenChange={(open) => {
          if (!open) {
            setAppearanceFolderId(null);
          }
        }}
        onSave={async ({ color, icon }) => {
          if (appearanceFolderId === null) {
            return;
          }
          try {
            await ipc.client.photos.updateFolderAppearance({
              color,
              icon,
              id: appearanceFolderId,
            });
            await queryClient.invalidateQueries({ queryKey: ["folders"] });
            toast.success(t("folderAppearanceSaved"));
            setAppearanceFolderId(null);
          } catch {
            toast.error(t("folderAppearanceSaveFailed"));
            throw new Error("Failed to save folder appearance");
          }
        }}
      />

      {/* Tag context menu */}
      {tagCtx && (
        <div
          className="fixed z-[200] min-w-[140px] animate-context-menu-enter overflow-hidden rounded-[8px] border border-border bg-popover py-1 ring-1 ring-foreground/5"
          ref={ctxRef}
          style={{
            left: Math.min(tagCtx.x, window.innerWidth - 160),
            top: Math.min(tagCtx.y, window.innerHeight - 140),
          }}
        >
          <div className="truncate px-3 py-1 font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider">
            {tagCtx.tagName}
          </div>
          <div className="mx-2 my-1 border-border border-t" />
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-foreground/5"
            onClick={() => {
              setChildTagParent({
                parentId: tagCtx.tagId,
                parentName: tagCtx.tagName,
              });
              setTagCtx(null);
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("tagCreateChild")}
          </button>
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-destructive transition-colors hover:bg-destructive/10"
            onClick={() => {
              setDeleteTagTarget({ id: tagCtx.tagId, name: tagCtx.tagName });
              setTagCtx(null);
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t("tagDeleteTitle")}
          </button>
        </div>
      )}

      {/* Create child tag dialog */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setChildTagParent(null);
            setNewChildTagName("");
          }
        }}
        open={childTagParent !== null}
      >
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t("tagCreateChild")}</DialogTitle>
            <DialogDescription>
              {t("parentTag", { name: childTagParent?.parentName ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <input
            autoFocus
            className="w-full rounded-[6px] border border-border bg-card px-3 py-2 text-[13px] text-foreground outline-none focus:border-primary/50"
            onChange={(e) => setNewChildTagName(e.target.value)}
            onCompositionEnd={(e) => {
              childComposingRef.current = false;
              setNewChildTagName((e.target as HTMLInputElement).value);
            }}
            onCompositionStart={() => {
              childComposingRef.current = true;
            }}
            onKeyDown={(e) => {
              if (childComposingRef.current) {
                return;
              }
              if (e.key === "Enter") {
                handleCreateChildTag();
              }
            }}
            placeholder={t("childTagPlaceholder")}
            ref={childInputRef}
            value={newChildTagName}
          />
          <DialogFooter>
            <button
              className="rounded-md border border-border px-4 py-1.5 font-medium text-[13px] text-muted-foreground transition-colors hover:bg-foreground/5"
              onClick={() => {
                setChildTagParent(null);
                setNewChildTagName("");
              }}
              type="button"
            >
              {t("cancel")}
            </button>
            <button
              className="rounded-md bg-primary px-4 py-1.5 font-medium text-[13px] text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
              disabled={!newChildTagName.trim()}
              onClick={handleCreateChildTag}
              type="button"
            >
              {t("confirm")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
