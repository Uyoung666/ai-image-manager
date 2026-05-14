import {
  Download,
  FolderPlus,
  Heart,
  ImageIcon,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface SelectionActionBarProps {
  allFavorite: boolean;
  onAddToAlbum: () => void;
  onClearSelection: () => void;
  onConvert: () => void;
  onDelete: () => void;
  onExport: () => void;
  onRename: () => void;
  onToggleFavorite: () => void;
  selectedCount: number;
}

export function SelectionActionBar({
  selectedCount,
  allFavorite,
  onToggleFavorite,
  onAddToAlbum,
  onExport,
  onRename,
  onConvert,
  onDelete,
  onClearSelection,
}: SelectionActionBarProps) {
  const [animating, setAnimating] = useState(false);
  const [visible, setVisible] = useState(false);
  const mountedRef = useRef(selectedCount > 0);

  useEffect(() => {
    if (selectedCount > 0) {
      mountedRef.current = true;
      setAnimating(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setVisible(true));
      });
    } else {
      setVisible(false);
    }
  }, [selectedCount]);

  if (!animating && !mountedRef.current) return null;

  return (
    <div
      className={`pointer-events-none absolute right-0 bottom-2 left-0 z-40 flex items-center justify-center px-4 transition-all duration-200 ease-out ${
        visible
          ? "translate-y-0 opacity-100"
          : "translate-y-3 opacity-0"
      }`}
      onTransitionEnd={() => {
        if (!visible) {
          setAnimating(false);
          mountedRef.current = false;
        }
      }}
    >
      <div className="pointer-events-auto flex items-center gap-1 rounded-[10px] border border-border bg-card/95 px-3 py-1.5 shadow-lg backdrop-blur-xl">
        <span className="mr-2 text-[12px] font-medium text-foreground tabular-nums">
          已选 {selectedCount} 张
        </span>

        <div className="mx-1 h-4 w-px bg-border" />

        <ActionButton
          icon={<Heart className={allFavorite ? "fill-current" : ""} size={15} />}
          label={allFavorite ? "取消收藏" : "收藏"}
          onClick={onToggleFavorite}
        />
        <ActionButton
          icon={<FolderPlus size={15} />}
          label="添加到相册"
          onClick={onAddToAlbum}
        />
        <ActionButton
          icon={<Download size={15} />}
          label="导出"
          onClick={onExport}
        />
        <ActionButton
          icon={<Pencil size={15} />}
          label="重命名"
          onClick={onRename}
        />
        <ActionButton
          icon={<ImageIcon size={15} />}
          label="格式转换"
          onClick={onConvert}
        />

        <div className="mx-1 h-4 w-px bg-border" />

        <ActionButton
          className="text-destructive hover:bg-destructive/10"
          icon={<Trash2 size={15} />}
          label="删除"
          onClick={onDelete}
        />

        <div className="mx-1 h-4 w-px bg-border" />

        <button
          className="flex items-center gap-1 rounded-[6px] px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          onClick={onClearSelection}
          title="取消选择 (Esc)"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

function ActionButton({
  icon,
  label,
  onClick,
  className = "",
}: {
  className?: string;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`flex items-center gap-1.5 rounded-[6px] px-2.5 py-1.5 text-[11px] text-foreground/80 transition-colors hover:bg-foreground/8 hover:text-foreground ${className}`}
      onClick={onClick}
      title={label}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
