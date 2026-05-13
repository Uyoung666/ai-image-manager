import { useCallback, useEffect } from "react";

interface Shortcut {
  keys: string[];
  label: string;
  section: string;
}

const SHORTCUTS: Shortcut[] = [
  { section: "浏览", keys: ["Space"], label: "快速预览选中照片" },
  { section: "浏览", keys: ["←", "→"], label: "预览/灯箱中切换照片" },
  { section: "浏览", keys: ["Esc"], label: "关闭预览/灯箱/面板" },
  { section: "浏览", keys: ["双击"], label: "打开灯箱查看" },
  { section: "选择", keys: ["点击"], label: "选中照片" },
  { section: "选择", keys: ["Ctrl", "点击"], label: "多选/取消选中" },
  { section: "选择", keys: ["Shift", "点击"], label: "范围选择" },
  { section: "选择", keys: ["Ctrl", "A"], label: "全选" },
  { section: "操作", keys: ["Delete"], label: "删除选中照片" },
  { section: "操作", keys: ["F"], label: "收藏/取消收藏" },
  { section: "操作", keys: ["I"], label: "显示/隐藏详情面板" },
  { section: "操作", keys: ["右键"], label: "打开右键菜单" },
  { section: "界面", keys: ["["], label: "折叠/展开侧边栏" },
  { section: "界面", keys: ["Ctrl", "K"], label: "聚焦搜索" },
  { section: "界面", keys: ["?"], label: "显示/隐藏快捷键面板" },
  { section: "灯箱", keys: ["Space"], label: "播放/暂停幻灯片" },
  { section: "灯箱", keys: ["Esc"], label: "退出灯箱" },
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

  const sections = [...new Set(SHORTCUTS.map((s) => s.section))];

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="w-[420px] max-h-[80vh] overflow-y-auto rounded-[12px] border border-border bg-popover ring-1 ring-white/5">
        <div className="flex items-center justify-between border-border border-b px-5 py-4">
          <h2 className="font-[590] text-foreground text-[16px]">键盘快捷键</h2>
          <button
            className="text-[#6b6b75] transition-colors hover:text-foreground"
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
        <div className="space-y-4 p-5">
          {sections.map((section) => (
            <div key={section}>
              <h3 className="mb-1.5 font-[510] text-[11px] text-[#6b6b75] uppercase tracking-wider">
                {section}
              </h3>
              <div className="space-y-0.5">
                {SHORTCUTS.filter((s) => s.section === section).map((s) => (
                  <div className="flex items-center justify-between py-1" key={s.label}>
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
          ))}
        </div>
      </div>
    </div>
  );
}
