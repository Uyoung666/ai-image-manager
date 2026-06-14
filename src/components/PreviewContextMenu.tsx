import { Copy, FolderOpen, Image } from "lucide-react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

interface PreviewMenuState {
  open: boolean;
  photoPath: string | null;
  x: number;
  y: number;
}

interface PreviewContextMenuProps {
  menu: PreviewMenuState;
  onClose: () => void;
  onOpenExplorer: (path: string) => void;
}

export type { PreviewMenuState };

/** Lightbox / QuickPreview 右键菜单 — 复制图片、复制路径、在资源管理器中打开 */
export function PreviewContextMenu({
  menu,
  onClose,
  onOpenExplorer,
}: PreviewContextMenuProps) {
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

  const x = Math.min(menu.x, window.innerWidth - 190);
  const y = Math.min(menu.y, window.innerHeight - 130);

  return createPortal(
    <div
      className="fixed min-w-[210px] rounded-[8px] border border-border bg-popover p-1 ring-1 ring-foreground/5"
      ref={ref}
      style={{ left: x, top: y, zIndex: 99_999 }}
    >
      <button
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-[4px] px-3 py-1.5 text-[13px] text-foreground hover:bg-foreground/10"
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
      <button
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-[4px] px-3 py-1.5 text-[13px] text-foreground hover:bg-foreground/10"
        disabled={!menu.photoPath}
        onClick={() => {
          if (menu.photoPath) {
            navigator.clipboard.writeText(menu.photoPath).catch(() => {});
          }
          onClose();
        }}
      >
        <Copy className="h-3.5 w-3.5 flex-shrink-0" />
        {t("copyPath")}
      </button>
      <button
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-[4px] px-3 py-1.5 text-[13px] text-foreground hover:bg-foreground/10"
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
    </div>,
    document.body
  );
}
