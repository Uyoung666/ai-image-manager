import { useNavigate } from "@tanstack/react-router";
import {
  Album,
  CircleHelp,
  Folder,
  LayoutDashboard,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  ScanSearch,
  Settings,
  Trash2,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/ipc/manager";
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
}
interface SidebarProps {
  activeFolderId: number | null;
  collapsed: boolean;
  folders: FolderInfo[];
  onAddFolder: () => void;
  onDeleteFolder: (id: number, displayName: string) => void;
  onSelectFolder: (id: number | null) => void;
  onSelectTag?: (tagId: number | null) => void;
  onToggleCollapse: () => void;
  scanningFolder: string | null;
  scanProgress: string;
  totalPhotos: number;
}

export function Sidebar({
  folders,
  activeFolderId,
  collapsed,
  onSelectFolder,
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

  useEffect(() => {
    let running = true;
    let interval: ReturnType<typeof setInterval> | null = null;

    async function loadTags() {
      try {
        const result = await ipc.client.photos.getTags({});
        if (!running) return;
        const tagList = (result as TagInfo[]) || [];
        setTags(tagList);
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
  }, [totalPhotos]);

  const closeCtx = useCallback(() => setFolderCtx(null), []);

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
          className="mb-2 flex h-8 w-8 items-center justify-center rounded-[6px] text-[#6b6b75] transition-colors hover:bg-foreground/5 hover:text-foreground"
          onClick={onToggleCollapse}
          title="展开侧边栏"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>

        <div className="flex flex-1 flex-col items-center gap-1 overflow-y-auto px-1.5">
          <button
            className={`flex h-8 w-8 items-center justify-center rounded-[6px] transition-colors ${
              activeFolderId === null
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
            }`}
            onClick={() => onSelectFolder(null)}
            title={t("sidebarAllPhotos")}
          >
            <Folder className="h-4 w-4" />
          </button>

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
          <p className="mt-0.5 text-[#6b6b75] text-[11px]">
            {t("photosCount", { count: totalPhotos.toLocaleString() })}
          </p>
        </div>
        <button
          className="flex h-7 w-7 items-center justify-center rounded-[6px] text-[#6b6b75] transition-colors hover:bg-foreground/5 hover:text-foreground"
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
            activeFolderId === null
              ? "bg-primary/15 text-primary"
              : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          }`}
          onClick={() => onSelectFolder(null)}
        >
          {t("sidebarAllPhotos")}
        </button>
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
              <p className="mt-0.5 truncate text-[#6b6b75] text-[10px]">
                {t("scanningPath", { path: scanningFolder })}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Separator */}
      <div className="mx-3 my-2 border-border border-t" />

      {/* Folders */}
      <div className="flex-1 overflow-y-auto px-3">
        <p className="px-3 py-1 font-[510] text-[#6b6b75] text-[11px] uppercase tracking-wider">
          {t("sidebarFolders")}
        </p>
        {folders.map((folder) => (
          <button
            className={`flex w-full items-center gap-2 rounded-[6px] px-3 py-1.5 text-left text-[13px] transition-colors ${
              activeFolderId === folder.id
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
            }`}
            key={folder.id}
            onClick={() => onSelectFolder(folder.id)}
            onContextMenu={(e) =>
              handleFolderContextMenu(e, folder.id, folder.displayName)
            }
          >
            <Folder className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="truncate">{folder.displayName}</span>
            <span className="ml-auto text-[#6b6b75] text-[10px] tabular-nums">
              {folder.photoCount}
            </span>
          </button>
        ))}
        {folders.length === 0 && (
          <p className="px-3 py-2 text-[#6b6b75] text-[12px]">
            {t("sidebarNoFolders")}
          </p>
        )}

        {/* Tags */}
        {tags.length > 0 && (
          <>
            <div className="mx-3 my-2 border-border border-t" />
            <p className="px-3 py-1 font-[510] text-[#6b6b75] text-[11px] uppercase tracking-wider">
              标签
            </p>
            <div className="px-1 pb-1">
              <input
                className="w-full rounded-[4px] bg-card px-2 py-1 text-[11px] text-foreground outline-none placeholder:text-[#6b6b75]"
                onChange={(e) => setTagSearch(e.target.value)}
                placeholder="搜索标签..."
                value={tagSearch}
              />
            </div>
            <div className="max-h-[160px] overflow-y-auto">
              {tags
                .filter((t) =>
                  tagSearch
                    ? t.name.toLowerCase().includes(tagSearch.toLowerCase())
                    : true
                )
                .map((tag) => (
                  <button
                    className={`group/tag flex w-full items-center gap-2 rounded-[6px] px-3 py-1 text-left text-[12px] transition-colors ${
                      activeTagId === tag.id
                        ? "bg-primary/15 text-primary"
                        : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                    }`}
                    key={tag.id}
                    onClick={() => {
                      const nextId = activeTagId === tag.id ? null : tag.id;
                      setActiveTagId(nextId);
                      onSelectTag?.(nextId);
                    }}
                    onContextMenu={async (e) => {
                      e.preventDefault();
                      if (confirm(`删除标签 "${tag.name}"？`)) {
                        try {
                          await ipc.client.photos.deleteTag({ id: tag.id });
                          const updated = await ipc.client.photos.getTags({});
                          setTags((updated as TagInfo[]) || []);
                          if (activeTagId === tag.id) {
                            setActiveTagId(null);
                            onSelectTag?.(null);
                          }
                        } catch {
                          /* ignore delete errors */
                        }
                      }
                    }}
                  >
                    <span
                      className="h-2 w-2 flex-shrink-0 rounded-full"
                      style={{ background: tag.color || "var(--primary)" }}
                    />
                    <span className="truncate">{tag.name}</span>
                  </button>
                ))}
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
          className="w-full rounded-[6px] px-3 py-1.5 text-left text-[13px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          onClick={() => navigate({ to: "/albums" as "/albums" })}
        >
          <Album className="mr-2 inline h-3.5 w-3.5" />
          相册
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

      {/* Folder context menu */}
      {folderCtx && (
        <div
          className="fixed z-[200] min-w-[140px] overflow-hidden rounded-[8px] border border-border bg-popover py-1 ring-1 ring-white/5"
          ref={ctxRef}
          style={{ left: folderCtx.x, top: folderCtx.y }}
        >
          <div className="truncate px-3 py-1 font-[510] text-[#6b6b75] text-[10px] uppercase tracking-wider">
            {folderCtx.displayName}
          </div>
          <div className="mx-2 my-1 border-border border-t" />
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[#e5484d] text-[13px] transition-colors hover:bg-[#e5484d]/10"
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
