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
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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

const FOCUSABLE_SELECTOR =
  "a[href], button:not(:disabled), input:not(:disabled):not([type='hidden']), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";

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
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });

  const restoreFocus = useCallback(() => {
    const previousFocus = previousFocusRef.current;
    previousFocusRef.current = null;
    if (
      previousFocus &&
      previousFocus !== document.body &&
      previousFocus.isConnected
    ) {
      previousFocus.focus();
    }
  }, []);

  const closeMenu = useCallback(() => {
    restoreFocus();
    onClose();
  }, [onClose, restoreFocus]);

  useLayoutEffect(() => {
    if (!menu.open) {
      return;
    }
    const activeElement = document.activeElement;
    previousFocusRef.current =
      activeElement instanceof HTMLElement && activeElement !== document.body
        ? activeElement
        : null;
    ref.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
    return restoreFocus;
  }, [menu.open, restoreFocus]);

  useEffect(() => {
    if (!menu.open) {
      return;
    }
    const dismiss = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        closeMenu();
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", dismiss, true);
      document.addEventListener("contextmenu", dismiss, true);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", dismiss, true);
      document.removeEventListener("contextmenu", dismiss, true);
    };
  }, [closeMenu, menu.open]);

  const handleMenuKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      // Context-menu keyboard input belongs to the menu and must not reach
      // gallery/router shortcut listeners.
      event.stopPropagation();
      if (event.key === "Tab") {
        event.preventDefault();
        const previousFocus = previousFocusRef.current;
        const focusableElements = Array.from(
          document.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
        ).filter((element) => !ref.current?.contains(element));
        let destination = previousFocus;
        if (previousFocus) {
          const currentIndex = focusableElements.indexOf(previousFocus);
          if (currentIndex >= 0) {
            destination =
              focusableElements[currentIndex + (event.shiftKey ? -1 : 1)] ??
              previousFocus;
          }
        } else if (focusableElements.length > 0) {
          destination = event.shiftKey
            ? (focusableElements.at(-1) ?? null)
            : focusableElements[0];
        }
        closeMenu();
        destination?.focus();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
        return;
      }
      if (
        !["ArrowDown", "ArrowUp", "End", "Enter", "Home"].includes(event.key)
      ) {
        return;
      }
      event.preventDefault();

      const items = Array.from(
        ref.current?.querySelectorAll<HTMLButtonElement>(
          "button:not(:disabled)"
        ) ?? []
      );
      if (items.length === 0) {
        return;
      }
      const currentIndex = items.indexOf(
        document.activeElement as HTMLButtonElement
      );
      if (event.key === "Enter") {
        if (currentIndex >= 0) {
          items[currentIndex]?.click();
        }
        return;
      }

      let nextIndex = 0;
      if (event.key === "ArrowDown") {
        nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
      } else if (event.key === "ArrowUp") {
        nextIndex =
          currentIndex < 0
            ? items.length - 1
            : (currentIndex - 1 + items.length) % items.length;
      } else if (event.key === "End") {
        nextIndex = items.length - 1;
      }
      items[nextIndex]?.focus();
    },
    [closeMenu]
  );

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
      // getBoundingClientRect includes the entry animation's scale transform.
      // Position against the untransformed layout size so the menu still fits
      // after the spring animation expands it to its final size.
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      const left = Math.max(
        viewportMargin,
        Math.min(
          menu.x,
          Math.max(viewportMargin, window.innerWidth - width - viewportMargin)
        )
      );
      const top = Math.max(
        viewportMargin,
        Math.min(
          menu.y,
          Math.max(viewportMargin, window.innerHeight - height - viewportMargin)
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
    deleteLabel = t("sequenceDeleteWhole", {
      count: menu.sequenceMemberIds.length,
    });
  } else if (menu.isBatch) {
    deleteLabel = `${t("deletePhoto")} (${menu.selectionCount})`;
  }

  return createPortal(
    <div
      className="surface-elevated fixed z-50 max-h-[calc(100dvh-1rem)] w-[min(210px,calc(100dvw-1rem))] min-w-0 animate-context-menu-enter overflow-y-auto overscroll-contain rounded-[8px] border border-border bg-popover p-1 ring-1 ring-foreground/5 [&_button]:min-w-0 [&_button]:whitespace-normal [&_button]:break-words"
      data-overlay-kind="context-menu"
      data-surface="overlay"
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      onKeyDown={handleMenuKeyDown}
      ref={ref}
      role="menu"
      style={position}
    >
      <button
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-[4px] px-3 py-1.5 text-[13px] text-foreground hover:bg-foreground/10 disabled:text-muted-foreground/50 disabled:hover:bg-transparent"
        disabled={!menu.photoPath}
        onClick={() => {
          if (menu.photoPath) {
            onOpenExplorer(menu.photoPath);
          }
          closeMenu();
        }}
        role="menuitem"
        type="button"
      >
        <FolderOpen className="h-3.5 w-3.5 flex-shrink-0" />
        {t("openInExplorer")}
      </button>
      <button
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-[4px] px-3 py-1.5 text-[13px] text-foreground hover:bg-foreground/10 disabled:text-muted-foreground/50 disabled:hover:bg-transparent"
        disabled={!menu.photoPath}
        onClick={async () => {
          if (menu.photoPath) {
            try {
              await navigator.clipboard.writeText(menu.photoPath);
              toast.success(t("pathCopied"));
            } catch {
              toast.error(t("copyFailed"));
            }
          }
          closeMenu();
        }}
        role="menuitem"
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
            try {
              const ok = await window.electronAPI?.copyImageToClipboard?.(
                menu.photoPath
              );
              if (ok) {
                toast.success(t("imageCopiedToClipboard"));
              } else {
                toast.error(t("copyFailed"));
              }
            } catch {
              toast.error(t("copyFailed"));
            }
          }
          closeMenu();
        }}
        role="menuitem"
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
            closeMenu();
          }}
          role="menuitem"
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
          closeMenu();
        }}
        role="menuitem"
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
            closeMenu();
          }}
          role="menuitem"
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
            closeMenu();
          }}
          role="menuitem"
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
            closeMenu();
          }}
          role="menuitem"
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
          closeMenu();
        }}
        role="menuitem"
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
            closeMenu();
          }}
          role="menuitem"
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
            closeMenu();
          }}
          role="menuitem"
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
          closeMenu();
        }}
        role="menuitem"
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
