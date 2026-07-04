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
      <div className="selection-menu pointer-events-auto">
        <span className="selection-menu-count">
          {t("selectedPhotos", { count: selectedCount })}
        </span>

        {onToggleFavorite && (
          <>
            <div className="selection-menu-divider" />
            <MenuAction
              executing={executing === "favorite"}
              icon={
                <Heart
                  className={allFavorite ? "fill-current" : ""}
                  size={18}
                />
              }
              label={allFavorite ? t("unfavorite") : t("favorite")}
              onClick={onToggleFavorite}
            />
          </>
        )}
        {onAddToAlbum && (
          <MenuAction
            icon={<FolderPlus size={18} />}
            label={t("addToAlbum")}
            onClick={onAddToAlbum}
          />
        )}
        {onStartCull && (
          <>
            <div className="selection-menu-divider" />
            <MenuAction
              icon={<Swords size={18} />}
              label={t("cullStart")}
              onClick={onStartCull}
            />
          </>
        )}
        {onExport && (
          <MenuAction
            icon={<Download size={18} />}
            label={t("export")}
            onClick={onExport}
          />
        )}
        {onUploadToCloud && (
          <MenuAction
            icon={<CloudUpload size={18} />}
            label={t("upload")}
            onClick={onUploadToCloud}
          />
        )}
        {onShare && (
          <MenuAction
            icon={<Share2 size={18} />}
            label={t("share")}
            onClick={onShare}
          />
        )}
        {onRename && (
          <MenuAction
            icon={<Pencil size={18} />}
            label={t("rename")}
            onClick={onRename}
          />
        )}
        {onConvert && (
          <MenuAction
            icon={<ImageIcon size={18} />}
            label={t("convertFormat")}
            onClick={onConvert}
          />
        )}

        {onDelete && (
          <>
            <div className="selection-menu-divider" />
            <MenuAction
              destructive
              disabled={executing !== null}
              executing={executing === "delete"}
              icon={<Trash2 size={18} />}
              label={t("delete")}
              onClick={wrapAction("delete", onDelete)}
            />
          </>
        )}

        <div className="selection-menu-divider" />

        <button
          className="selection-menu-link"
          onClick={onClearSelection}
          title={t("clearSelectionTitle")}
        >
          <span className="selection-menu-icon">
            <X size={18} />
          </span>
          <span className="selection-menu-title">{t("clearSelection")}</span>
        </button>
      </div>
    </div>
  );
}

function MenuAction({
  icon,
  label,
  onClick,
  destructive = false,
  disabled = false,
  executing = false,
}: {
  destructive?: boolean;
  disabled?: boolean;
  executing?: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`selection-menu-link${destructive ? " selection-menu-destructive" : ""}`}
      disabled={disabled}
      onClick={onClick}
      title={label}
    >
      <span className="selection-menu-icon">
        {executing ? (
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
        ) : (
          icon
        )}
      </span>
      <span className="selection-menu-title">{label}</span>
    </button>
  );
}
