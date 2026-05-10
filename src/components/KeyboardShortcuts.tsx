import { useEffect, useCallback } from "react";

interface Shortcut {
  keys: string[];
  label: string;
}

const SHORTCUTS: Shortcut[] = [
  { keys: ["Ctrl", "K"], label: "聚焦搜索" },
  { keys: ["Esc"], label: "关闭灯箱 / 菜单" },
  { keys: ["?", "?"], label: "显示 / 隐藏快捷键面板" },
  { keys: ["←", "→"], label: "灯箱中切换上一张 / 下一张" },
  { keys: ["Ctrl", "点击"], label: "多选照片" },
  { keys: ["双击"], label: "打开灯箱预览" },
  { keys: ["右键"], label: "打开右键菜单" },
];

interface KeyboardShortcutsProps {
  open: boolean;
  onClose: () => void;
}

export function KeyboardShortcuts({ open, onClose }: KeyboardShortcutsProps) {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  }, [onClose]);

  useEffect(() => {
    if (open) {
      document.addEventListener("keydown", handleKeyDown);
      return () => document.removeEventListener("keydown", handleKeyDown);
    }
  }, [open, handleKeyDown]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-[#1c1e22] border border-[#2c2c30] rounded-[12px] shadow-[0_16px_60px_rgba(0,0,0,0.5)] w-[400px] overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[rgba(255,255,255,0.06)]">
          <h2 className="text-[#f7f8f8] text-[16px] font-[590]">键盘快捷键</h2>
          <button
            onClick={onClose}
            className="text-[#6b6b75] hover:text-[#f7f8f8] transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="p-5 space-y-2">
          {SHORTCUTS.map((s, i) => (
            <div key={i} className="flex items-center justify-between py-1.5">
              <span className="text-[#a1a1aa] text-[13px]">{s.label}</span>
              <div className="flex items-center gap-1">
                {s.keys.map((k, j) => (
                  <span
                    key={j}
                    className="min-w-[28px] px-1.5 py-0.5 text-[11px] font-[510] text-[#a1a1aa] bg-[#121214] border border-[#2c2c30] rounded-[4px] text-center"
                  >
                    {k}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
