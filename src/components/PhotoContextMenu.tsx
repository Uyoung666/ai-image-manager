import {
  Album,
  CloudUpload,
  Copy,
  Download,
  FolderOpen,
  Share2,
  Star,
  Trash2,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

interface MenuState {
  open: boolean;
  photoId: number | null;
  photoPath: string | null;
  x: number;
  y: number;
}

interface PhotoContextMenuProps {
  menu: MenuState;
  onAddToAlbum: (id: number) => void;
  onClose: () => void;
  onDelete: (id: number) => void;
  onExport: (id: number) => void;
  onOpenExplorer: (path: string) => void;
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
  onExport,
  onOpenExplorer,
  onToggleFavorite,
  onUploadToCloud,
  onShare,
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

  return (
    <div
      className="fixed z-50 min-w-[180px] rounded-[8px] border border-border bg-popover p-1 ring-1 ring-foreground/5"
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
      {onToggleFavorite && (
        <button
          className="flex w-full cursor-pointer items-center gap-2.5 rounded-[4px] px-3 py-1.5 text-[13px] text-foreground hover:bg-foreground/10 disabled:text-muted-foreground/50 disabled:hover:bg-transparent"
          disabled={menu.photoId === null}
          onClick={() => {
            if (menu.photoId !== null) {
              onToggleFavorite(menu.photoId);
            }
            onClose();
          }}
        >
          <Star className="h-3.5 w-3.5 flex-shrink-0" />
          {t("shortcutToggleFavorite")}
        </button>
      )}
      <div className="my-1 h-px bg-border" />
      <button
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-[4px] px-3 py-1.5 text-[13px] text-foreground hover:bg-foreground/10 disabled:text-muted-foreground/50 disabled:hover:bg-transparent"
        disabled={menu.photoId === null}
        onClick={() => {
          if (menu.photoId !== null) {
            onAddToAlbum(menu.photoId);
          }
          onClose();
        }}
      >
        <Album className="h-3.5 w-3.5 flex-shrink-0" />
        {t("addToAlbum")}
      </button>
      <button
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-[4px] px-3 py-1.5 text-[13px] text-foreground hover:bg-foreground/10 disabled:text-muted-foreground/50 disabled:hover:bg-transparent"
        disabled={menu.photoId === null}
        onClick={() => {
          if (menu.photoId !== null) {
            onExport(menu.photoId);
          }
          onClose();
        }}
      >
        <Download className="h-3.5 w-3.5 flex-shrink-0" />
        {t("exportPhoto")}
      </button>
      {onUploadToCloud && (
        <button
          className="flex w-full cursor-pointer items-center gap-2.5 rounded-[4px] px-3 py-1.5 text-[13px] text-foreground hover:bg-foreground/10 disabled:text-muted-foreground/50 disabled:hover:bg-transparent"
          disabled={menu.photoId === null}
          onClick={() => {
            if (menu.photoId !== null) {
              onUploadToCloud(menu.photoId);
            }
            onClose();
          }}
        >
          <CloudUpload className="h-3.5 w-3.5 flex-shrink-0" />
          {t("cloudUploadTitle")}
        </button>
      )}
      {onShare && (
        <button
          className="flex w-full cursor-pointer items-center gap-2.5 rounded-[4px] px-3 py-1.5 text-[13px] text-foreground hover:bg-foreground/10 disabled:text-muted-foreground/50 disabled:hover:bg-transparent"
          disabled={menu.photoId === null}
          onClick={() => {
            if (menu.photoId !== null) {
              onShare(menu.photoId);
            }
            onClose();
          }}
        >
          <Share2 className="h-3.5 w-3.5 flex-shrink-0" />
          {t("generateSharePage")}
        </button>
      )}
      <div className="my-1 h-px bg-border" />
      <button
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-[4px] px-3 py-1.5 text-[13px] text-destructive hover:bg-foreground/10 disabled:text-muted-foreground/50 disabled:hover:bg-transparent"
        disabled={menu.photoId === null}
        onClick={() => {
          if (menu.photoId !== null) {
            onDelete(menu.photoId);
          }
          onClose();
        }}
      >
        <Trash2 className="h-3.5 w-3.5 flex-shrink-0" />
        {t("deletePhoto")}
      </button>
    </div>
  );
}
