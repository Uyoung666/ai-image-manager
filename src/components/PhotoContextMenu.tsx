// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: scoped component lint cleanup preserves existing UI behavior
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
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  const [position, setPosition] = useState({ left: 8, top: 8 });

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

  useLayoutEffect(() => {
    if (!(menu.open && ref.current)) {
      return;
    }
    const viewportMargin = 8;
    const updatePosition = () => {
      const element = ref.current;
      if (!element) {
        return;
      }
      const bounds = element.getBoundingClientRect();
      const left = Math.max(
        viewportMargin,
        Math.min(
          menu.x,
          Math.max(
            viewportMargin,
            window.innerWidth - bounds.width - viewportMargin
          )
        )
      );
      const top = Math.max(
        viewportMargin,
        Math.min(
          menu.y,
          Math.max(
            viewportMargin,
            window.innerHeight - bounds.height - viewportMargin
          )
        )
      );
      setPosition((current) =>
        current.left === left && current.top === top ? current : { left, top }
      );
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    return () => window.removeEventListener("resize", updatePosition);
  }, [menu.open, menu.x, menu.y]);

  if (!menu.open) {
    return null;
  }

  let deleteLabel = t("deletePhoto");
  if (menu.sequenceMemberIds) {
    deleteLabel = `删除整个序列（${menu.sequenceMemberIds.length}）`;
  } else if (menu.isBatch) {
    deleteLabel = `${t("deletePhoto")} (${menu.selectionCount})`;
  }

  return createPortal(
    <div
      className="surface-elevated fixed z-50 max-h-[calc(100dvh-1rem)] w-[min(210px,calc(100dvw-1rem))] min-w-0 animate-context-menu-enter overflow-y-auto overscroll-contain rounded-[8px] border border-border bg-popover p-1 ring-1 ring-foreground/5 [&_button]:min-w-0 [&_button]:whitespace-normal [&_button]:break-words"
      ref={ref}
      style={position}
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
        type="button"
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
        type="button"
      >
        <Copy className="h-3.5 w-3.5 flex-shrink-0" />
        {t("copyPath")}
      </button>
      <button
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-[4px] px-3 py-1.5 text-[13px] text-foreground hover:bg-foreground/10 disabled:text-muted-foreground/50 disabled:hover:bg-transparent"
        disabled={!menu.photoPath}
        onClick={async () => {
          if (menu.photoPath) {
            const ok = await window.electronAPI?.copyImageToClipboard?.(
              menu.photoPath
            );
            if (ok) {
              toast.success(t("imageCopiedToClipboard"));
            }
          }
          onClose();
        }}
        type="button"
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
          type="button"
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
        type="button"
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
          type="button"
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
          type="button"
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
          type="button"
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
        type="button"
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
          type="button"
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
          type="button"
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
        type="button"
      >
        <Trash2 className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="flex-1 text-left">{deleteLabel}</span>
        <span className="ml-2 rounded-[3px] border border-border bg-secondary px-1 py-0.5 font-medium text-[10px] text-muted-foreground/60">
          Delete
        </span>
      </button>
    </div>,
    document.body
  );
}
