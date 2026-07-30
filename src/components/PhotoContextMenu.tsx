import {
  Album,
  CloudUpload,
  Copy,
  Download,
  FolderOpen,
  Image,
  MinusCircle,
  Share2,
  Star,
  Trash2,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

interface MenuState {
  isBatch: boolean;
  open: boolean;
  photoId: number | null;
  photoPath: string | null;
  selectionCount: number;
  sequenceMemberIds?: number[];
  x: number;
  y: number;
}

interface PhotoContextMenuProps {
  menu: MenuState;
  onAddToAlbum: (id: number) => void;
  onBatchAddToAlbum?: () => void;
  onBatchDelete?: () => void;
  onBatchExport?: () => void;
  onBatchRemoveFromAlbum?: () => void;
  onBatchShare?: () => void;
  onBatchToggleFavorite?: () => void;
  onBatchUploadToCloud?: () => void;
  onClose: () => void;
  onDelete: (id: number) => void;
  onDeleteSequenceGroup?: (ids: number[]) => void;
  onExport: (id: number) => void;
  onOpenExplorer: (path: string) => void;
  onRemoveFromAlbum?: (id: number) => void;
  onSetAsAlbumCover?: (id: number) => void;
  onSetAsPersonCover?: (id: number) => void;
  onShare?: (id: number) => void;
  onToggleFavorite?: (id: number) => void;
  onUploadToCloud?: (id: number) => void;
}

export type { MenuState };

export function PhotoContextMenu({
  menu,
  onAddToAlbum,
  onClose,
  onDelete,
  onDeleteSequenceGroup,
  onExport,
  onOpenExplorer,
  onToggleFavorite,
  onUploadToCloud,
  onRemoveFromAlbum,
  onSetAsAlbumCover,
  onSetAsPersonCover,
  onShare,
  onBatchDelete,
  onBatchExport,
  onBatchShare,
  onBatchUploadToCloud,
  onBatchToggleFavorite,
  onBatchAddToAlbum,
  onBatchRemoveFromAlbum,
}: PhotoContextMenuProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu.open) {
      return;
    }
    const dismiss = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", dismiss, true);
      document.addEventListener("contextmenu", dismiss, true);
    }, 0);
    document.addEventListener("keydown", keyHandler);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", dismiss, true);
      document.removeEventListener("contextmenu", dismiss, true);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [menu.open, onClose]);

  if (!menu.open) {
    return null;
  }

  // Clamp position to viewport
  const x = Math.min(menu.x, window.innerWidth - 190);
  const y = Math.min(menu.y, window.innerHeight - 160);
  let deleteLabel = t("deletePhoto");
  if (menu.sequenceMemberIds) {
    deleteLabel = `删除整个序列（${menu.sequenceMemberIds.length}）`;
  } else if (menu.isBatch) {
    deleteLabel = `${t("deletePhoto")} (${menu.selectionCount})`;
  }

  return (
    <div
      className="surface-elevated fixed z-50 min-w-[210px] animate-context-menu-enter rounded-[8px] border border-border bg-popover p-1 ring-1 ring-foreground/5"
      ref={ref}
      style={{ left: x, top: y }}
    >
      <button
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-[4px] px-3 py-1.5 text-[13px] text-foreground hover:bg-foreground/10 disabled:text-muted-foreground/50 disabled:hover:bg-transparent"
        disabled={!menu.photoPath}
        onClick={() => {
          if (menu.photoPath) {
            onOpenExplorer(menu.photoPath);
          }
          onClose();
        }}
      >
        <FolderOpen className="h-3.5 w-3.5 flex-shrink-0" />
        {t("openInExplorer")}
      </button>
      <button
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-[4px] px-3 py-1.5 text-[13px] text-foreground hover:bg-foreground/10 disabled:text-muted-foreground/50 disabled:hover:bg-transparent"
        disabled={!menu.photoPath}
        onClick={() => {
          if (menu.photoPath) {
            navigator.clipboard.writeText(menu.photoPath).catch(() => {
              /* ignore clipboard errors */
            });
          }
          onClose();
        }}
      >
        <Copy className="h-3.5 w-3.5 flex-shrink-0" />
        {t("copyPath")}
      </button>
      <button
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-[4px] px-3 py-1.5 text-[13px] text-foreground hover:bg-foreground/10 disabled:text-muted-foreground/50 disabled:hover:bg-transparent"
        disabled={!menu.photoPath}
        onClick={async () => {
          if (menu.photoPath) {
            const ok = await (
              window as any
            ).electronAPI?.copyImageToClipboard?.(menu.photoPath);
            if (ok) {
              toast.success(t("imageCopiedToClipboard"));
            }
          }
          onClose();
        }}
      >
        <Image className="h-3.5 w-3.5 flex-shrink-0" />
        {t("copyImage")}
      </button>
      {onToggleFavorite && (
        <button
          className="flex w-full cursor-pointer items-center gap-2.5 rounded-[4px] px-3 py-1.5 text-[13px] text-foreground hover:bg-foreground/10 disabled:text-muted-foreground/50 disabled:hover:bg-transparent"
          disabled={menu.photoId === null && !menu.isBatch}
          onClick={() => {
            if (menu.isBatch && onBatchToggleFavorite) {
              onBatchToggleFavorite();
            } else if (menu.photoId !== null) {
              onToggleFavorite(menu.photoId);
            }
            onClose();
          }}
        >
          <Star className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="flex-1 text-left">
            {menu.isBatch
              ? `${t("shortcutToggleFavorite")} (${menu.selectionCount})`
              : t("shortcutToggleFavorite")}
          </span>
          <span className="ml-2 rounded-[3px] border border-border bg-secondary px-1 py-0.5 font-medium text-[10px] text-muted-foreground/60">
            F
          </span>
        </button>
      )}
      <div className="my-1 h-px bg-border" />
      <button
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-[4px] px-3 py-1.5 text-[13px] text-foreground hover:bg-foreground/10 disabled:text-muted-foreground/50 disabled:hover:bg-transparent"
        disabled={menu.photoId === null && !menu.isBatch}
        onClick={() => {
          if (menu.isBatch && onBatchAddToAlbum) {
            onBatchAddToAlbum();
          } else if (menu.photoId !== null) {
            onAddToAlbum(menu.photoId);
          }
          onClose();
        }}
      >
        <Album className="h-3.5 w-3.5 flex-shrink-0" />
        {menu.isBatch
          ? `${t("addToAlbum")} (${menu.selectionCount})`
          : t("addToAlbum")}
      </button>
      {onRemoveFromAlbum && (
        <button
          className="flex w-full cursor-pointer items-center gap-2.5 rounded-[4px] px-3 py-1.5 text-[13px] text-destructive hover:bg-foreground/10 disabled:text-muted-foreground/50 disabled:hover:bg-transparent"
          disabled={menu.photoId === null && !menu.isBatch}
          onClick={() => {
            if (menu.isBatch && onBatchRemoveFromAlbum) {
              onBatchRemoveFromAlbum();
            } else if (menu.photoId !== null) {
              onRemoveFromAlbum(menu.photoId);
            }
            onClose();
          }}
        >
          <MinusCircle className="h-3.5 w-3.5 flex-shrink-0" />
          {menu.isBatch
            ? `${t("removeFromAlbum")} (${menu.selectionCount})`
            : t("removeFromAlbum")}
        </button>
      )}
      {onSetAsAlbumCover && (
        <button
          className="flex w-full cursor-pointer items-center gap-2.5 rounded-[4px] px-3 py-1.5 text-[13px] text-foreground hover:bg-foreground/10 disabled:text-muted-foreground/50 disabled:hover:bg-transparent"
          disabled={menu.photoId === null || menu.isBatch}
          onClick={() => {
            if (menu.photoId !== null) {
              onSetAsAlbumCover(menu.photoId);
            }
            onClose();
          }}
        >
          <Image className="h-3.5 w-3.5 flex-shrink-0" />
          {t("setAsAlbumCover")}
        </button>
      )}
      {onSetAsPersonCover && (
        <button
          className="flex w-full cursor-pointer items-center gap-2.5 rounded-[4px] px-3 py-1.5 text-[13px] text-foreground hover:bg-foreground/10 disabled:text-muted-foreground/50 disabled:hover:bg-transparent"
          disabled={menu.photoId === null || menu.isBatch}
          onClick={() => {
            if (menu.photoId !== null) {
              onSetAsPersonCover(menu.photoId);
            }
            onClose();
          }}
        >
          <Image className="h-3.5 w-3.5 flex-shrink-0" />
          {t("setAsPersonCover")}
        </button>
      )}
      <button
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-[4px] px-3 py-1.5 text-[13px] text-foreground hover:bg-foreground/10 disabled:text-muted-foreground/50 disabled:hover:bg-transparent"
        disabled={menu.photoId === null && !menu.isBatch}
        onClick={() => {
          if (menu.isBatch && onBatchExport) {
            onBatchExport();
          } else if (menu.photoId !== null) {
            onExport(menu.photoId);
          }
          onClose();
        }}
      >
        <Download className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="flex-1 text-left">
          {menu.isBatch
            ? `${t("exportPhoto")} (${menu.selectionCount})`
            : t("exportPhoto")}
        </span>
        <span className="ml-2 rounded-[3px] border border-border bg-secondary px-1 py-0.5 font-medium text-[10px] text-muted-foreground/60">
          Ctrl+Shift+E
        </span>
      </button>
      {onUploadToCloud && (
        <button
          className="flex w-full cursor-pointer items-center gap-2.5 rounded-[4px] px-3 py-1.5 text-[13px] text-foreground hover:bg-foreground/10 disabled:text-muted-foreground/50 disabled:hover:bg-transparent"
          disabled={menu.photoId === null && !menu.isBatch}
          onClick={() => {
            if (menu.isBatch && onBatchUploadToCloud) {
              onBatchUploadToCloud();
            } else if (menu.photoId !== null) {
              onUploadToCloud(menu.photoId);
            }
            onClose();
          }}
        >
          <CloudUpload className="h-3.5 w-3.5 flex-shrink-0" />
          {menu.isBatch
            ? `${t("cloudUploadTitle")} (${menu.selectionCount})`
            : t("cloudUploadTitle")}
        </button>
      )}
      {onShare && (
        <button
          className="flex w-full cursor-pointer items-center gap-2.5 rounded-[4px] px-3 py-1.5 text-[13px] text-foreground hover:bg-foreground/10 disabled:text-muted-foreground/50 disabled:hover:bg-transparent"
          disabled={menu.photoId === null && !menu.isBatch}
          onClick={() => {
            if (menu.isBatch && onBatchShare) {
              onBatchShare();
            } else if (menu.photoId !== null) {
              onShare(menu.photoId);
            }
            onClose();
          }}
        >
          <Share2 className="h-3.5 w-3.5 flex-shrink-0" />
          {menu.isBatch
            ? `${t("generateSharePage")} (${menu.selectionCount})`
            : t("generateSharePage")}
        </button>
      )}
      <div className="my-1 h-px bg-border" />
      <button
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-[4px] px-3 py-1.5 text-[13px] text-destructive hover:bg-foreground/10 disabled:text-muted-foreground/50 disabled:hover:bg-transparent"
        disabled={menu.photoId === null && !menu.isBatch}
        onClick={() => {
          if (menu.sequenceMemberIds && onDeleteSequenceGroup) {
            onDeleteSequenceGroup(menu.sequenceMemberIds);
          } else if (menu.isBatch && onBatchDelete) {
            onBatchDelete();
          } else if (menu.photoId !== null) {
            onDelete(menu.photoId);
          }
          onClose();
        }}
      >
        <Trash2 className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="flex-1 text-left">
          {deleteLabel}
        </span>
        <span className="ml-2 rounded-[3px] border border-border bg-secondary px-1 py-0.5 font-medium text-[10px] text-muted-foreground/60">
          Delete
        </span>
      </button>
    </div>
  );
}
