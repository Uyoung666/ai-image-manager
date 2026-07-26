import { ChevronRight, Folder as FolderIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
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
          className={`flex min-h-9 items-center gap-1 rounded-[6px] px-1.5 ${
            included ? "bg-primary/5" : "hover:bg-foreground/5"
          }`}
          style={{ paddingLeft: depth * 16 + 6 }}
        >
          <button
            aria-label={expanded ? t("collapseFolder") : t("expandFolder")}
            className="flex h-7 w-7 flex-none items-center justify-center rounded-[4px] text-muted-foreground disabled:invisible"
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
          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1 text-left has-disabled:cursor-default">
            <input
              checked={included}
              className="h-4 w-4 flex-none accent-primary"
              disabled={inherited}
              onChange={() => toggleFolder(node.folder.id)}
              type="checkbox"
            />
            <FolderIcon className="h-4 w-4 flex-none text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-[13px]">
              {node.folder.displayName}
            </span>
            <span className="flex-none text-[11px] text-muted-foreground">
              {node.folder.totalPhotoCount ?? node.folder.photoCount}
            </span>
          </label>
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
      <DialogContent className="grid-rows-[auto_minmax(0,1fr)_auto]" size="lg">
        <DialogHeader>
          <DialogTitle>{t("faceScanScopeTitle")}</DialogTitle>
          <DialogDescription>{t("faceScanScopeDescription")}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[55vh] min-h-48 overflow-y-auto rounded-[8px] border border-border bg-background p-1">
          {tree.length > 0 ? (
            tree.map((node) => renderNode(node))
          ) : (
            <div className="flex h-40 items-center justify-center text-[13px] text-muted-foreground">
              {t("faceScanScopeNoFolders")}
            </div>
          )}
        </div>
        <DialogFooter className="items-center sm:justify-between">
          <p className="text-[12px] text-muted-foreground">
            {selectedRoots.size > 0
              ? t("faceScanScopeSummary", {
                  count: selectedRoots.size,
                  photos: selectedPhotoCount,
                })
              : t("faceScanScopeRequired")}
          </p>
          <div className="flex justify-end gap-2">
            <button
              className="rounded-[6px] px-4 py-2 text-[12px] text-muted-foreground"
              disabled={saving}
              onClick={onClose}
              type="button"
            >
              {t("cancel")}
            </button>
            <button
              className="rounded-[6px] bg-primary px-4 py-2 text-[12px] text-primary-foreground disabled:opacity-50"
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
