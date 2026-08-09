import { Copy, FolderOpen, Image } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
          Math.max(viewportMargin, window.innerWidth - bounds.width - viewportMargin)
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
        current.left === left && current.top === top
          ? current
          : { left, top }
      );
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    return () => window.removeEventListener("resize", updatePosition);
  }, [menu.open, menu.x, menu.y]);

  if (!menu.open) {
    return null;
  }

  return createPortal(
    <div
      className="fixed max-h-[calc(100dvh-1rem)] w-[min(210px,calc(100dvw-1rem))] min-w-0 animate-context-menu-enter overflow-y-auto overscroll-contain rounded-[8px] border border-border bg-popover p-1 ring-1 ring-foreground/5 [&_button]:min-w-0 [&_button]:whitespace-normal [&_button]:break-words"
      ref={ref}
      style={{ ...position, zIndex: 99_999 }}
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
