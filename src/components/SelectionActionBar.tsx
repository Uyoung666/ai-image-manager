// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: scoped component lint cleanup preserves existing UI behavior
import {
  CheckCheck,
  CloudUpload,
  Download,
  Ellipsis,
  FolderPlus,
  Heart,
  ImageIcon,
  Pencil,
  Share2,
  Swords,
  Tags,
  Trash2,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BatchTagDialog } from "@/components/BatchTagDialog";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useReducedMotion } from "@/hooks/use-reduced-motion";

type ActionHandler = () => void | Promise<void>;

interface SelectionActionBarProps {
  allFavorite?: boolean;
  bottomOffset?: number | string;
  onAddToAlbum?: ActionHandler;
  onClearSelection: ActionHandler;
  onConvert?: ActionHandler;
  onDelete?: ActionHandler;
  onExport?: ActionHandler;
  onRename?: ActionHandler;
  onSelectAll?: ActionHandler;
  onShare?: ActionHandler;
  onStartCull?: ActionHandler;
  onToggleFavorite?: ActionHandler;
  onUploadToCloud?: ActionHandler;
  selectedCount: number;
  selectedIds?: number[];
  selectionScopeLabel?: string;
  selectionTotal?: number;
}

export function SelectionActionBar({
  selectedCount,
  selectedIds,
  allFavorite = false,
  bottomOffset,
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
  onSelectAll,
  selectionTotal,
  selectionScopeLabel,
}: SelectionActionBarProps) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const [animating, setAnimating] = useState(false);
  const [visible, setVisible] = useState(false);
  const [executing, setExecuting] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [tagEditorIds, setTagEditorIds] = useState<number[] | null>(null);
  const executingRef = useRef<string | null>(null);
  const mountedRef = useRef(selectedCount > 0);
  const layerRef = useRef<HTMLDivElement>(null);

  // Toasts live in a portal. Reserve their space from the actual toolbar bounds,
  // including compact layouts, page zoom, and the optional task status strip.
  // biome-ignore lint/correctness/useExhaustiveDependencies: bottomOffset can move the toolbar without resizing it.
  useEffect(() => {
    const layer = layerRef.current;
    if (!(visible && layer)) {
      return;
    }
    const update = () => {
      const bounds = layer.getBoundingClientRect();
      if (bounds.height > 0) {
        document.documentElement.style.setProperty(
          "--selection-notification-bottom",
          `${Math.ceil(window.innerHeight - bounds.top + 12)}px`
        );
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(layer);
    layer.addEventListener("transitionend", update);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      layer.removeEventListener("transitionend", update);
      window.removeEventListener("resize", update);
      document.documentElement.style.removeProperty(
        "--selection-notification-bottom"
      );
    };
  }, [visible, bottomOffset]);

  useEffect(() => {
    if (selectedCount > 0) {
      mountedRef.current = true;
      setAnimating(true);
      if (reduceMotion) {
        setVisible(true);
      } else {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => setVisible(true));
        });
      }
    } else {
      setMoreOpen(false);
      setVisible(false);
    }
  }, [reduceMotion, selectedCount]);

  function wrapAction(
    key: string,
    handler: ActionHandler,
    options?: { closeMore?: boolean }
  ): () => void {
    return async () => {
      if (executingRef.current !== null) {
        return;
      }
      if (options?.closeMore) {
        setMoreOpen(false);
      }
      executingRef.current = key;
      setExecuting(key);
      try {
        await handler();
      } finally {
        executingRef.current = null;
        setExecuting(null);
      }
    };
  }

  if (!(animating || mountedRef.current)) {
    return null;
  }

  return (
    <div
      className={`selection-action-layer pointer-events-none absolute right-0 left-0 z-40 flex min-w-0 items-center justify-center px-4 transition-all duration-200 ease-out ${
        visible ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"
      }`}
      data-selection-visible={visible ? "true" : "false"}
      onTransitionEnd={() => {
        if (!visible) {
          setAnimating(false);
          mountedRef.current = false;
        }
      }}
      ref={layerRef}
      style={
        bottomOffset === undefined
          ? undefined
          : {
              bottom:
                typeof bottomOffset === "number"
                  ? `${bottomOffset}px`
                  : bottomOffset,
            }
      }
    >
      <div className="selection-menu pointer-events-auto min-w-0 max-w-full">
        <Tooltip>
          <TooltipTrigger asChild>
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need the selection-scope Tooltip. */}
            <span className="selection-menu-count" tabIndex={0}>
              {selectionTotal === undefined
                ? t("selectedPhotos", { count: selectedCount })
                : t("selectedPhotosInScope", {
                    count: selectedCount,
                    total: selectionTotal,
                  })}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {selectionScopeLabel ??
              t("selectedPhotos", { count: selectedCount })}
          </TooltipContent>
        </Tooltip>
        {onSelectAll &&
          selectionTotal !== undefined &&
          selectedCount < selectionTotal && (
            <MenuAction
              disabled={executing !== null}
              icon={<CheckCheck size={18} />}
              label={selectionScopeLabel ?? t("selectAll")}
              onClick={wrapAction("select-all", onSelectAll)}
              shortLabel={t("selectAll")}
            />
          )}

        {onToggleFavorite && (
          <>
            <div className="selection-menu-divider" />
            <MenuAction
              disabled={executing !== null}
              executing={executing === "favorite"}
              icon={
                <Heart
                  className={allFavorite ? "fill-current" : ""}
                  size={18}
                />
              }
              label={allFavorite ? t("unfavorite") : t("favorite")}
              onClick={wrapAction("favorite", onToggleFavorite)}
            />
          </>
        )}
        {onAddToAlbum && (
          <MenuAction
            disabled={executing !== null}
            executing={executing === "album"}
            icon={<FolderPlus size={18} />}
            label={t("addToAlbum")}
            onClick={wrapAction("album", onAddToAlbum)}
          />
        )}
        {selectedIds && selectedIds.length > 0 && (
          <MenuAction
            disabled={executing !== null}
            executing={false}
            icon={<Tags size={18} />}
            label={t("batchTagsAction")}
            onClick={() => setTagEditorIds([...selectedIds])}
          />
        )}
        {onExport && (
          <MenuAction
            disabled={executing !== null}
            executing={executing === "export"}
            icon={<Download size={18} />}
            label={t("export")}
            onClick={wrapAction("export", onExport)}
          />
        )}

        {tagEditorIds && (
          <BatchTagDialog
            onClose={() => setTagEditorIds(null)}
            photoIds={tagEditorIds}
          />
        )}

        {(onStartCull ||
          onUploadToCloud ||
          onShare ||
          onRename ||
          onConvert) && (
          <MoreActions
            disabled={executing !== null}
            executing={executing}
            label={t("moreActions")}
            onOpenChange={setMoreOpen}
            open={moreOpen}
          >
            {onStartCull && (
              <MoreAction
                disabled={executing !== null || selectedCount < 2}
                disabledReason={
                  selectedCount < 2 ? t("cullRequiresTwoPhotos") : undefined
                }
                executing={executing === "cull"}
                icon={<Swords size={16} />}
                label={t("cullStart")}
                onClick={wrapAction("cull", onStartCull, { closeMore: true })}
              />
            )}
            {onUploadToCloud && (
              <MoreAction
                disabled={executing !== null}
                executing={executing === "upload"}
                icon={<CloudUpload size={16} />}
                label={t("cloudUploadTitle")}
                onClick={wrapAction("upload", onUploadToCloud, {
                  closeMore: true,
                })}
              />
            )}
            {onShare && (
              <MoreAction
                disabled={executing !== null}
                executing={executing === "share"}
                icon={<Share2 size={16} />}
                label={t("generateSharePage")}
                onClick={wrapAction("share", onShare, { closeMore: true })}
              />
            )}
            {onRename && (
              <MoreAction
                disabled={executing !== null}
                executing={executing === "rename"}
                icon={<Pencil size={16} />}
                label={t("rename")}
                onClick={wrapAction("rename", onRename, { closeMore: true })}
              />
            )}
            {onConvert && (
              <MoreAction
                disabled={executing !== null}
                executing={executing === "convert"}
                icon={<ImageIcon size={16} />}
                label={t("convertFormat")}
                onClick={wrapAction("convert", onConvert, { closeMore: true })}
              />
            )}
          </MoreActions>
        )}

        {onDelete && (
          <>
            <div className="selection-menu-divider" />
            <MenuAction
              destructive
              disabled={executing !== null}
              edge
              executing={executing === "delete"}
              icon={<Trash2 size={18} />}
              label={t("delete")}
              onClick={wrapAction("delete", onDelete)}
            />
          </>
        )}

        <div className="selection-menu-divider" />

        <MenuAction
          disabled={executing !== null}
          edge
          executing={executing === "clear"}
          icon={<X size={18} />}
          label={t("clearSelection")}
          onClick={wrapAction("clear", onClearSelection)}
        />
      </div>
    </div>
  );
}

function MoreActions({
  children,
  disabled,
  executing,
  label,
  onOpenChange,
  open,
}: {
  children: ReactNode;
  disabled: boolean;
  executing: string | null;
  label: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  return (
    <Popover onOpenChange={onOpenChange} open={open}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              aria-expanded={open}
              aria-label={label}
              className="selection-menu-link"
              disabled={disabled}
              type="button"
            >
              <span className="selection-menu-icon">
                {executing &&
                executing !== "delete" &&
                executing !== "clear" ? (
                  <LoadingSpinner size="sm" variant="inherit" />
                ) : (
                  <Ellipsis size={18} />
                )}
              </span>
              <span className="selection-menu-title">{label}</span>
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="center"
        className="selection-more-menu max-h-[min(20rem,var(--radix-popover-content-available-height))] w-48 max-w-[calc(100vw-1rem)] gap-0 overflow-y-auto overscroll-contain p-1.5"
        collisionPadding={8}
        side="top"
        sideOffset={10}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

function MoreAction({
  icon,
  label,
  onClick,
  disabled = false,
  disabledReason,
  executing = false,
}: {
  disabled?: boolean;
  disabledReason?: string;
  executing?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  const action = (
    <button
      className="selection-more-menu-item"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <span className="selection-more-menu-icon">
        {executing ? <LoadingSpinner size="sm" variant="inherit" /> : icon}
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );

  if (!disabledReason) {
    return action;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="block w-full"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: disabled action wrapper must expose its tooltip to keyboard users
          tabIndex={0}
        >
          {action}
        </span>
      </TooltipTrigger>
      <TooltipContent>{disabledReason}</TooltipContent>
    </Tooltip>
  );
}

function MenuAction({
  icon,
  label,
  shortLabel,
  onClick,
  destructive = false,
  disabled = false,
  edge = false,
  executing = false,
}: {
  destructive?: boolean;
  disabled?: boolean;
  edge?: boolean;
  executing?: boolean;
  icon: ReactNode;
  label: string;
  shortLabel?: string;
  onClick: () => void;
}) {
  const className = [
    "selection-menu-link",
    destructive ? "selection-menu-destructive" : "",
    edge ? "selection-menu-link-edge" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={label}
          className={className}
          disabled={disabled}
          onClick={onClick}
          type="button"
        >
          <span className="selection-menu-icon">
            {executing ? <LoadingSpinner size="sm" variant="inherit" /> : icon}
          </span>
          <span className="selection-menu-title">{shortLabel ?? label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
