import { ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderBadge } from "@/components/FolderBadge";
import {
  buildFolderTree,
  type FolderTreeNode,
} from "@/components/sidebar-trees";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getFolderSubtreeIds } from "@/services/folder-hierarchy";
import type { Folder } from "@/types/photo";
import { normalizeFaceScanFolderIds } from "@/utils/face-scan-scope";

interface FaceScanScopeDialogProps {
  folders: Folder[];
  initialFolderIds: number[];
  onClose: () => void;
  onSave: (folderIds: number[]) => Promise<void>;
  open: boolean;
}

export function FaceScanScopeDialog({
  folders,
  initialFolderIds,
  onClose,
  onSave,
  open,
}: FaceScanScopeDialogProps) {
  const { t } = useTranslation();
  const tree = useMemo(() => buildFolderTree(folders), [folders]);
  const folderMap = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder])),
    [folders]
  );
  const [selectedRoots, setSelectedRoots] = useState<Set<number>>(new Set());
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    const normalized = normalizeFaceScanFolderIds(folders, initialFolderIds);
    setSelectedRoots(new Set(normalized));
    const expanded = new Set(tree.map((node) => node.folder.id));
    for (const folderId of normalized) {
      let current = folderMap.get(folderId);
      const visited = new Set<number>();
      while (current?.parentId != null && !visited.has(current.parentId)) {
        visited.add(current.parentId);
        expanded.add(current.parentId);
        current = folderMap.get(current.parentId);
      }
    }
    setExpandedIds(expanded);
  }, [folderMap, folders, initialFolderIds, open, tree]);

  const selectedPhotoCount = useMemo(
    () =>
      [...selectedRoots].reduce((sum, folderId) => {
        const folder = folderMap.get(folderId);
        return sum + (folder?.totalPhotoCount ?? folder?.photoCount ?? 0);
      }, 0),
    [folderMap, selectedRoots]
  );

  function hasSelectedAncestor(folderId: number): boolean {
    let current = folderMap.get(folderId);
    const visited = new Set<number>();
    while (current?.parentId != null && !visited.has(current.parentId)) {
      if (selectedRoots.has(current.parentId)) {
        return true;
      }
      visited.add(current.parentId);
      current = folderMap.get(current.parentId);
    }
    return false;
  }

  function toggleFolder(folderId: number) {
    if (hasSelectedAncestor(folderId)) {
      return;
    }
    setSelectedRoots((previous) => {
      const next = new Set(previous);
      if (next.has(folderId)) {
        next.delete(folderId);
        return next;
      }
      next.add(folderId);
      for (const descendantId of getFolderSubtreeIds(folders, folderId)) {
        if (descendantId !== folderId) {
          next.delete(descendantId);
        }
      }
      return new Set(normalizeFaceScanFolderIds(folders, [...next]));
    });
  }

  function toggleExpanded(folderId: number) {
    setExpandedIds((previous) => {
      const next = new Set(previous);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  }

  function renderNode(node: FolderTreeNode, depth = 0): React.ReactNode {
    const hasChildren = node.children.length > 0;
    const expanded = expandedIds.has(node.folder.id);
    const selected = selectedRoots.has(node.folder.id);
    const inherited = hasSelectedAncestor(node.folder.id);
    const included = selected || inherited;

    return (
      <div key={node.folder.id}>
        <div
          className="flex min-h-9 items-center gap-1 rounded-[6px] px-1.5 transition-colors hover:bg-foreground/5 dark:hover:bg-white/[0.045]"
          style={{ paddingLeft: depth * 16 + 6 }}
        >
          <button
            aria-label={expanded ? t("collapseFolder") : t("expandFolder")}
            className="flex h-7 w-7 flex-none items-center justify-center rounded-[4px] text-muted-foreground transition-colors hover:text-foreground disabled:invisible"
            disabled={!hasChildren}
            onClick={() => toggleExpanded(node.folder.id)}
            type="button"
          >
            <ChevronRight
              className={`h-3.5 w-3.5 transition-transform ${
                expanded ? "rotate-90" : ""
              }`}
            />
          </button>
          <div className="checkbox-wrapper min-w-0 flex-1">
            <input
              checked={included}
              className="check"
              disabled={inherited}
              id={`face-scan-folder-${node.folder.id}`}
              onChange={() => toggleFolder(node.folder.id)}
              type="checkbox"
            />
            <label
              className={`label flex min-w-0 flex-1 items-center gap-2 py-1 text-left ${
                inherited ? "cursor-default" : ""
              }`}
              htmlFor={`face-scan-folder-${node.folder.id}`}
            >
              <svg
                aria-hidden="true"
                className="flex-none text-foreground/55 dark:text-white/45"
                height="45"
                viewBox="0 0 95 95"
                width="45"
              >
                <rect
                  fill="none"
                  height="50"
                  stroke="currentColor"
                  width="50"
                  x="30"
                  y="20"
                />
                <g transform="translate(0,-952.36222)">
                  <path
                    className="path1"
                    d="m 56,963 c -102,122 6,9 7,9 17,-5 -66,69 -38,52 122,-77 -7,14 18,4 29,-11 45,-43 23,-4"
                    fill="none"
                    stroke="var(--danger)"
                    strokeWidth="3"
                  />
                </g>
              </svg>
              <FolderBadge className="h-5 w-5" folder={node.folder} />
              <span className="min-w-0 flex-1 truncate font-medium text-[13px] text-foreground/90">
                {node.folder.displayName}
              </span>
              <span className="flex-none rounded-full bg-foreground/5 px-2 py-0.5 text-[11px] text-muted-foreground dark:bg-white/[0.055]">
                {node.folder.totalPhotoCount ?? node.folder.photoCount}
              </span>
            </label>
          </div>
        </div>
        {expanded && node.children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  }

  async function save() {
    if (selectedRoots.size === 0 || saving) {
      return;
    }
    setSaving(true);
    try {
      await onSave([...selectedRoots]);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!(next || saving)) {
          onClose();
        }
      }}
      open={open}
    >
      <DialogContent
        className="grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden border-border/80 bg-popover p-0 shadow-2xl dark:border-white/[0.09] dark:bg-[#121318] dark:ring-white/[0.04]"
        overlayClassName="bg-black/70 backdrop-blur-[2px]"
        size="lg"
      >
        <DialogHeader className="px-5 pt-5 pb-4">
          <DialogTitle className="text-[16px]">
            {t("faceScanScopeTitle")}
          </DialogTitle>
          <DialogDescription className="leading-relaxed dark:text-white/50">
            {t("faceScanScopeDescription")}
          </DialogDescription>
        </DialogHeader>
        <div className="mx-5 max-h-[55vh] min-h-48 overflow-y-auto rounded-[8px] border border-border/80 bg-background/70 p-1.5 shadow-inner dark:border-white/[0.07] dark:bg-[#090a0e]">
          {tree.length > 0 ? (
            tree.map((node) => renderNode(node))
          ) : (
            <div className="flex h-40 items-center justify-center text-[13px] text-muted-foreground">
              {t("faceScanScopeNoFolders")}
            </div>
          )}
        </div>
        <DialogFooter className="mt-4 items-center border-border/70 border-t bg-muted/20 px-5 py-4 sm:justify-between dark:border-white/[0.07] dark:bg-white/[0.018]">
          <p className="text-[12px] text-muted-foreground dark:text-white/45">
            {selectedRoots.size > 0
              ? t("faceScanScopeSummary", {
                  count: selectedRoots.size,
                  photos: selectedPhotoCount,
                })
              : t("faceScanScopeRequired")}
          </p>
          <div className="flex justify-end gap-2">
            <button
              className="rounded-[6px] border border-transparent px-4 py-2 text-[12px] text-muted-foreground transition-colors hover:border-border hover:bg-foreground/5 hover:text-foreground dark:hover:border-white/10 dark:hover:bg-white/5"
              disabled={saving}
              onClick={onClose}
              type="button"
            >
              {t("cancel")}
            </button>
            <button
              className="rounded-[6px] bg-primary px-4 py-2 font-medium text-[12px] text-primary-foreground shadow-sm transition-colors hover:bg-[var(--primary-hover)] disabled:opacity-50"
              disabled={selectedRoots.size === 0 || saving}
              onClick={save}
              type="button"
            >
              {saving ? t("saving") : t("save")}
            </button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
