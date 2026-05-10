import { useCallback, useEffect } from "react";

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
  onClose: () => void;
  open: boolean;
}

export function KeyboardShortcuts({ open, onClose }: KeyboardShortcutsProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    },
    [onClose]
  );

  useEffect(() => {
    if (open) {
      document.addEventListener("keydown", handleKeyDown);
      return () => document.removeEventListener("keydown", handleKeyDown);
    }
  }, [open, handleKeyDown]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="w-[400px] overflow-hidden rounded-[12px] border border-[#2c2c30] bg-[#1c1e22] shadow-[0_16px_60px_rgba(0,0,0,0.5)]">
        <div className="flex items-center justify-between border-[rgba(255,255,255,0.06)] border-b px-5 py-4">
          <h2 className="font-[590] text-[#f7f8f8] text-[16px]">键盘快捷键</h2>
          <button
            className="text-[#6b6b75] transition-colors hover:text-[#f7f8f8]"
            onClick={onClose}
          >
            <svg
              fill="none"
              height="16"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              viewBox="0 0 24 24"
              width="16"
            >
              <line x1="18" x2="6" y1="6" y2="18" />
              <line x1="6" x2="18" y1="6" y2="18" />
            </svg>
          </button>
        </div>
        <div className="space-y-2 p-5">
          {SHORTCUTS.map((s, i) => (
            <div className="flex items-center justify-between py-1.5" key={i}>
              <span className="text-[#a1a1aa] text-[13px]">{s.label}</span>
              <div className="flex items-center gap-1">
                {s.keys.map((k, j) => (
                  <span
                    className="min-w-[28px] rounded-[4px] border border-[#2c2c30] bg-[#121214] px-1.5 py-0.5 text-center font-[510] text-[#a1a1aa] text-[11px]"
                    key={j}
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
