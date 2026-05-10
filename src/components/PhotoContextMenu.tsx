import { useEffect, useRef } from "react";

interface MenuState {
  open: boolean;
  photoId: number | null;
  photoPath: string | null;
  x: number;
  y: number;
}

interface PhotoContextMenuProps {
  menu: MenuState;
  onClose: () => void;
  onDelete: (id: number) => void;
  onOpenExplorer: (path: string) => void;
}

export type { MenuState };

export function PhotoContextMenu({
  menu,
  onOpenExplorer,
  onDelete,
  onClose,
}: PhotoContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu.open) {
      return;
    }
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Delay to avoid the same right-click event closing it
    const timer = setTimeout(
      () => document.addEventListener("click", handler),
      0
    );
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", keyHandler);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("click", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [menu.open, onClose]);

  if (!menu.open) {
    return null;
  }

  // Clamp position to viewport
  const x = Math.min(menu.x, window.innerWidth - 190);
  const y = Math.min(menu.y, window.innerHeight - 150);

  return (
    <div
      className="fixed z-50 min-w-[180px] rounded-[8px] border border-[#2c2c30] bg-[#1c1e22] p-1 shadow-[0_8px_30px_rgba(0,0,0,0.5)]"
      ref={ref}
      style={{ left: x, top: y }}
    >
      <button
        className="flex w-full cursor-default items-center gap-2 rounded-[4px] px-3 py-1.5 text-[#f7f8f8] text-[13px] hover:bg-white/10 disabled:text-[#6b6b75] disabled:hover:bg-transparent"
        disabled={!menu.photoPath}
        onClick={() => {
          if (menu.photoPath) {
            onOpenExplorer(menu.photoPath);
          }
          onClose();
        }}
      >
        <svg
          fill="none"
          height="14"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width="14"
        >
          <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
        </svg>
        在资源管理器中打开
      </button>
      <button
        className="flex w-full cursor-default items-center gap-2 rounded-[4px] px-3 py-1.5 text-[#f7f8f8] text-[13px] hover:bg-white/10 disabled:text-[#6b6b75] disabled:hover:bg-transparent"
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
        <svg
          fill="none"
          height="14"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width="14"
        >
          <rect height="13" rx="2" ry="2" width="13" x="9" y="9" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
        复制路径
      </button>
      <div className="my-1 h-px bg-[#2c2c30]" />
      <button
        className="flex w-full cursor-default items-center gap-2 rounded-[4px] px-3 py-1.5 text-[#e5484d] text-[13px] hover:bg-white/10 disabled:text-[#6b6b75] disabled:hover:bg-transparent"
        disabled={menu.photoId === null}
        onClick={() => {
          if (menu.photoId !== null) {
            onDelete(menu.photoId);
          }
          onClose();
        }}
      >
        <svg
          fill="none"
          height="14"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width="14"
        >
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
        删除照片
      </button>
    </div>
  );
}
