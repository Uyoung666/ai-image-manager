import { useEffect, useRef } from "react";

interface MenuState {
  open: boolean;
  x: number;
  y: number;
  photoId: number | null;
  photoPath: string | null;
}

interface PhotoContextMenuProps {
  menu: MenuState;
  onOpenExplorer: (path: string) => void;
  onDelete: (id: number) => void;
  onClose: () => void;
}

export type { MenuState };

export function PhotoContextMenu({ menu, onOpenExplorer, onDelete, onClose }: PhotoContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu.open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Delay to avoid the same right-click event closing it
    const timer = setTimeout(() => document.addEventListener("click", handler), 0);
    const keyHandler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", keyHandler);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("click", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [menu.open, onClose]);

  if (!menu.open) return null;

  // Clamp position to viewport
  const x = Math.min(menu.x, window.innerWidth - 190);
  const y = Math.min(menu.y, window.innerHeight - 150);

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[180px] rounded-[8px] border border-[#2c2c30] bg-[#1c1e22] p-1 shadow-[0_8px_30px_rgba(0,0,0,0.5)]"
      style={{ left: x, top: y }}
    >
      <button
        onClick={() => { if (menu.photoPath) onOpenExplorer(menu.photoPath); onClose(); }}
        disabled={!menu.photoPath}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-[13px] text-[#f7f8f8] rounded-[4px] cursor-default hover:bg-white/10 disabled:text-[#6b6b75] disabled:hover:bg-transparent"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
        </svg>
        在资源管理器中打开
      </button>
      <button
        onClick={() => {
          if (menu.photoPath) navigator.clipboard.writeText(menu.photoPath).catch(() => {});
          onClose();
        }}
        disabled={!menu.photoPath}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-[13px] text-[#f7f8f8] rounded-[4px] cursor-default hover:bg-white/10 disabled:text-[#6b6b75] disabled:hover:bg-transparent"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
        复制路径
      </button>
      <div className="my-1 h-px bg-[#2c2c30]" />
      <button
        onClick={() => { if (menu.photoId !== null) onDelete(menu.photoId); onClose(); }}
        disabled={menu.photoId === null}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-[13px] text-[#e5484d] rounded-[4px] cursor-default hover:bg-white/10 disabled:text-[#6b6b75] disabled:hover:bg-transparent"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
        删除照片
      </button>
    </div>
  );
}
