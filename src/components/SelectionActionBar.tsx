import {
  CloudUpload,
  Download,
  FolderPlus,
  Heart,
  ImageIcon,
  Pencil,
  Share2,
  Swords,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface SelectionActionBarProps {
  allFavorite?: boolean;
  onAddToAlbum?: () => void;
  onClearSelection: () => void;
  onConvert?: () => void;
  onDelete?: () => void;
  onExport?: () => void;
  onRename?: () => void;
  onShare?: () => void;
  onStartCull?: () => void;
  onToggleFavorite?: () => void;
  onUploadToCloud?: () => void;
  selectedCount: number;
}

export function SelectionActionBar({
  selectedCount,
  allFavorite = false,
  onToggleFavorite,
  onAddToAlbum,
  onExport,
  onRename,
  onConvert,
  onDelete,
  onClearSelection,
  onUploadToCloud,
  onShare,
  onStartCull,
}: SelectionActionBarProps) {
  const { t } = useTranslation();
  const [animating, setAnimating] = useState(false);
  const [visible, setVisible] = useState(false);
  const [executing, setExecuting] = useState<string | null>(null);
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

  function wrapAction(
    key: string,
    handler?: () => void
  ): (() => void) | undefined {
    if (!handler) {
      return undefined;
    }
    return async () => {
      setExecuting(key);
      try {
        await handler();
      } finally {
        setExecuting(null);
      }
    };
  }

  if (!(animating || mountedRef.current)) {
    return null;
  }

  return (
    <div
      className={`pointer-events-none absolute right-0 bottom-9 left-0 z-40 flex items-center justify-center px-4 transition-all duration-200 ease-out ${
        visible ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"
      }`}
      onTransitionEnd={() => {
        if (!visible) {
          setAnimating(false);
          mountedRef.current = false;
        }
      }}
    >
      <div className="glass-surface pointer-events-auto flex items-center gap-1 rounded-[10px] border border-border px-3 py-1.5 shadow-lg">
        <span className="mr-2 font-medium text-[12px] text-foreground tabular-nums">
          {t("selectedPhotos", { count: selectedCount })}
        </span>

        {onToggleFavorite && (
          <>
            <div className="mx-1 h-4 w-px bg-border" />
            <ActionButton
              icon={
                <Heart
                  className={allFavorite ? "fill-current" : ""}
                  size={15}
                />
              }
              label={allFavorite ? t("unfavorite") : t("favorite")}
              onClick={onToggleFavorite}
            />
          </>
        )}
        {onAddToAlbum && (
          <ActionButton
            icon={<FolderPlus size={15} />}
            label={t("addToAlbum")}
            onClick={onAddToAlbum}
          />
        )}
        {onStartCull && (
          <>
            <div className="mx-1 h-4 w-px bg-border" />
            <ActionButton
              icon={<Swords size={15} />}
              label={t("cullStart")}
              onClick={onStartCull}
            />
          </>
        )}
        {onExport && (
          <ActionButton
            icon={<Download size={15} />}
            label={t("export")}
            onClick={onExport}
          />
        )}
        {onUploadToCloud && (
          <ActionButton
            icon={<CloudUpload size={15} />}
            label={t("upload")}
            onClick={onUploadToCloud}
          />
        )}
        {onShare && (
          <ActionButton
            icon={<Share2 size={15} />}
            label={t("share")}
            onClick={onShare}
          />
        )}
        {onRename && (
          <ActionButton
            icon={<Pencil size={15} />}
            label={t("rename")}
            onClick={onRename}
          />
        )}
        {onConvert && (
          <ActionButton
            icon={<ImageIcon size={15} />}
            label={t("convertFormat")}
            onClick={onConvert}
          />
        )}

        {onDelete && (
          <>
            <div className="mx-1 h-4 w-px bg-border" />
            <ActionButton
              className="text-destructive hover:bg-destructive/10"
              disabled={executing !== null}
              executing={executing === "delete"}
              icon={<Trash2 size={15} />}
              label={t("delete")}
              onClick={wrapAction("delete", onDelete)}
            />
          </>
        )}

        <div className="mx-1 h-4 w-px bg-border" />

        <button
          className="flex items-center gap-1 rounded-[6px] px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          onClick={onClearSelection}
          title={t("clearSelectionTitle")}
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
  disabled = false,
  executing = false,
}: {
  className?: string;
  disabled?: boolean;
  executing?: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`flex items-center gap-1.5 rounded-[6px] px-2.5 py-1.5 text-[11px] text-foreground/80 transition-colors hover:bg-foreground/8 hover:text-foreground disabled:opacity-40 ${className}`}
      disabled={disabled || executing}
      onClick={onClick}
      title={label}
    >
      {executing ? (
        <div className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
      ) : (
        icon
      )}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
