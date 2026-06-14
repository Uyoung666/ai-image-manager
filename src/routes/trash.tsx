import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { usePhotoSelection } from "@/hooks/usePhotoSelection";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
import { ipc } from "@/ipc/manager";
import { queryClient } from "@/providers/QueryProvider";
import { toLocalMediaUrl } from "@/utils/local-media-url";

interface DeletedPhoto {
  deletedAt: number | null;
  filename: string;
  fileSize: number | null;
  folderId: number | null;
  folderName: string | null;
  height: number | null;
  id: number;
  path: string;
  thumbnailPath: string | null;
  width: number | null;
}

function TrashPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const routeKey = "trash";
  const [photos, setPhotos] = useState<DeletedPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const {
    selectedIds,
    handleSelect,
    handleMarqueeSelect,
    clearSelection,
    handleKeyboardSelect,
  } = usePhotoSelection(routeKey, photos);
  const [restoring, setRestoring] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmPermanent, setConfirmPermanent] = useState(false);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [marquee, setMarquee] = useState<{
    startX: number;
    startY: number;
    x: number;
    y: number;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const marqueeJustCompleted = useRef(false);
  const [ctxMenu, setCtxMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    photoId: number | null;
    isBatch: boolean;
    selectionCount: number;
  }>({
    open: false,
    x: 0,
    y: 0,
    photoId: null,
    isBatch: false,
    selectionCount: 0,
  });

  const loadPhotos = useCallback(async () => {
    try {
      const result = await ipc.client.photos.listDeletedPhotos();
      setPhotos(result as DeletedPhoto[]);
    } catch {
      toast.error(t("trashLoadFailed"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPhotos();
  }, [loadPhotos]);

  // 集成路由滚动位置管理（使用 elementFromPoint O(1) 锚点，比 querySelectorAll 更高效）
  useRouteScrollRestoration(scrollRef, {
    getRouteKey: () => routeKey,
    getCurrentAnchor: () => {
      const el = scrollRef.current;
      if (!el || photos.length === 0) {
        return null;
      }
      // 用 elementFromPoint O(1) 替代 querySelectorAll O(n)，避免每帧全量 DOM 遍历
      const containerRect = el.getBoundingClientRect();
      const sampleY = containerRect.top + 40; // 从视口顶部向下 40px 取样（跳过 padding）
      const sampleX = containerRect.left + containerRect.width / 2;
      const element = document.elementFromPoint(sampleX, sampleY);
      const card = element?.closest("[data-photo-id]") as HTMLElement | null;
      if (!card) {
        return null;
      }
      const id = Number(card.dataset.photoId);
      if (!id) {
        return null;
      }
      const cardRect = card.getBoundingClientRect();
      const cardTopInContainer =
        cardRect.top - containerRect.top + el.scrollTop;
      return {
        itemId: id,
        offsetFromTop: el.scrollTop - cardTopInContainer,
      };
    },
    restoreFromAnchor: (anchorItemId: number) => {
      const el = scrollRef.current;
      if (!el) {
        return null;
      }
      const card = el.querySelector(`[data-photo-id="${anchorItemId}"]`);
      if (!card) {
        return null;
      }
      const cardRect = card.getBoundingClientRect();
      const containerRect = el.getBoundingClientRect();
      return cardRect.top - containerRect.top + el.scrollTop;
    },
  });

  function toggleSelect(id: number, e: React.MouseEvent) {
    handleSelect(id, e);
  }

  function selectAll() {
    if (selectedIds.size === photos.length) {
      clearSelection();
    } else {
      handleMarqueeSelect(new Set(photos.map((p) => p.id)));
    }
  }

  async function handleRestore() {
    if (selectedIds.size === 0) {
      return;
    }
    setRestoring(true);
    try {
      const result = (await ipc.client.photos.restorePhotos({
        ids: [...selectedIds],
      })) as { restored: number; restoredWithoutFolder: number };
      if (result.restoredWithoutFolder > 0 && result.restored > 0) {
        toast.success(t("restoredPhotosCount", { count: result.restored }));
        toast.warning(
          t("restoredWithoutFolderWarning", {
            count: result.restoredWithoutFolder,
          })
        );
      } else if (result.restoredWithoutFolder > 0) {
        toast.warning(
          t("restoredWithoutFolderWarning", {
            count: result.restoredWithoutFolder,
          })
        );
      } else {
        toast.success(t("restoredPhotosCount", { count: result.restored }));
      }
      clearSelection();
      queryClient.invalidateQueries({ queryKey: ["photos"] });
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      loadPhotos();
    } catch {
      toast.error(t("restoreFailed"));
    } finally {
      setRestoring(false);
    }
  }

  async function performPermanentDelete() {
    setConfirmPermanent(false);
    setDeleting(true);
    try {
      await ipc.client.photos.permanentlyDeletePhotos({
        ids: [...selectedIds],
      });
      toast.success(t("permanentlyDeletedCount", { count: selectedIds.size }));
      clearSelection();
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      loadPhotos();
    } catch {
      toast.error(t("deleteFailed"));
    } finally {
      setDeleting(false);
    }
  }

  async function performEmptyTrash() {
    setConfirmEmpty(false);
    setDeleting(true);
    try {
      await ipc.client.photos.emptyTrash();
      toast.success(t("trashEmptied"));
      clearSelection();
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      setPhotos([]);
    } catch {
      toast.error(t("emptyTrashFailed"));
    } finally {
      setDeleting(false);
    }
  }

  function handlePermanentDelete() {
    if (selectedIds.size === 0) {
      return;
    }
    setConfirmPermanent(true);
  }

  function handleEmptyTrash() {
    if (photos.length === 0) {
      return;
    }
    setConfirmEmpty(true);
  }

  // --- Marquee selection ---
  function handleMarqueeStart(e: React.MouseEvent) {
    if (e.button !== 0) {
      return;
    }
    const target = e.target as HTMLElement;
    if (target.closest("[data-photo-id]")) {
      return;
    }
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const rect = el.getBoundingClientRect();
    setMarquee({
      startX: e.clientX - rect.left + el.scrollLeft,
      startY: e.clientY - rect.top + el.scrollTop,
      x: e.clientX - rect.left + el.scrollLeft,
      y: e.clientY - rect.top + el.scrollTop,
    });
  }

  useEffect(() => {
    if (!marquee) {
      return;
    }
    const el = scrollRef.current;
    if (!el) {
      return;
    }

    function handleMouseMove(e: MouseEvent) {
      if (!el) {
        return;
      }
      const rect = el.getBoundingClientRect();
      setMarquee((prev) =>
        prev
          ? {
              ...prev,
              x: e.clientX - rect.left + el.scrollLeft,
              y: e.clientY - rect.top + el.scrollTop,
            }
          : null
      );
    }

    function handleMouseUp() {
      const scrollEl = el;
      setMarquee((prev) => {
        if (!(prev && scrollEl)) {
          return null;
        }
        const minX = Math.min(prev.startX, prev.x);
        const maxX = Math.max(prev.startX, prev.x);
        const minY = Math.min(prev.startY, prev.y);
        const maxY = Math.max(prev.startY, prev.y);

        if (maxX - minX > 5 || maxY - minY > 5) {
          const cards = scrollEl.querySelectorAll("[data-photo-id]");
          const selected = new Set<number>();
          const containerRect = scrollEl.getBoundingClientRect();
          for (const card of cards) {
            const r = card.getBoundingClientRect();
            const cardLeft = r.left - containerRect.left + scrollEl.scrollLeft;
            const cardTop = r.top - containerRect.top + scrollEl.scrollTop;
            if (
              cardLeft < maxX &&
              cardLeft + r.width > minX &&
              cardTop < maxY &&
              cardTop + r.height > minY
            ) {
              const id = Number((card as HTMLElement).dataset.photoId);
              if (id) {
                selected.add(id);
              }
            }
          }
          if (selected.size > 0) {
            handleMarqueeSelect(selected);
            marqueeJustCompleted.current = true;
          }
        }
        return null;
      });
    }

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [marquee]);

  // --- Context menu ---
  function handleContextMenu(e: React.MouseEvent) {
    const card = (e.target as HTMLElement).closest(
      "[data-photo-id]"
    ) as HTMLElement | null;
    if (!card) {
      return;
    }
    const id = Number(card.dataset.photoId || "0");
    if (!id) {
      return;
    }
    e.preventDefault();
    const inSelection = selectedIds.has(id);
    const isBatch = selectedIds.size > 1 && inSelection;
    setCtxMenu({
      open: true,
      x: e.clientX,
      y: e.clientY,
      photoId: id,
      isBatch,
      selectionCount: isBatch ? selectedIds.size : 1,
    });
  }

  function closeCtxMenu() {
    setCtxMenu((prev) => ({ ...prev, open: false }));
  }

  useEffect(() => {
    if (!ctxMenu.open) {
      return;
    }
    function dismiss(e: MouseEvent) {
      const menuEl = document.getElementById("trash-context-menu");
      if (menuEl && !menuEl.contains(e.target as Node)) {
        closeCtxMenu();
      }
    }
    function keyHandler(e: KeyboardEvent) {
      if (e.key === "Escape") {
        closeCtxMenu();
      }
    }
    setTimeout(() => {
      document.addEventListener("mousedown", dismiss, true);
      document.addEventListener("contextmenu", dismiss, true);
    }, 0);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", dismiss, true);
      document.removeEventListener("contextmenu", dismiss, true);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [ctxMenu.open]);

  async function handleCtxRestore() {
    closeCtxMenu();
    if (ctxMenu.isBatch) {
      // 右键目标已在选中集合中，直接使用 selectedIds
      await handleRestore();
      return;
    }
    // 单张模式：只恢复右键那张
    if (ctxMenu.photoId === null) {
      return;
    }
    setRestoring(true);
    try {
      const result = (await ipc.client.photos.restorePhotos({
        ids: [ctxMenu.photoId],
      })) as { restored: number; restoredWithoutFolder: number };
      if (result.restoredWithoutFolder > 0 && result.restored > 0) {
        toast.success(t("restoredPhotosCount", { count: result.restored }));
        toast.warning(
          t("restoredWithoutFolderWarning", {
            count: result.restoredWithoutFolder,
          })
        );
      } else if (result.restoredWithoutFolder > 0) {
        toast.warning(
          t("restoredWithoutFolderWarning", {
            count: result.restoredWithoutFolder,
          })
        );
      } else {
        toast.success(t("restoredPhotosCount", { count: result.restored }));
      }
      queryClient.invalidateQueries({ queryKey: ["photos"] });
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      loadPhotos();
    } catch {
      toast.error(t("restoreFailed"));
    } finally {
      setRestoring(false);
    }
  }

  function handleCtxDelete() {
    closeCtxMenu();
    if (ctxMenu.isBatch) {
      // 批量模式：使用 selectedIds
      handlePermanentDelete();
      return;
    }
    // 单张模式：先选中再删除
    if (ctxMenu.photoId === null) {
      return;
    }
    handleKeyboardSelect(ctxMenu.photoId);
    setConfirmPermanent(true);
  }

  function formatTimeAgo(ts: number | null): string {
    if (!ts) {
      return "";
    }
    const diff = Date.now() - ts;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days === 0) {
      return t("today");
    }
    if (days === 1) {
      return t("yesterday");
    }
    if (days < 7) {
      return t("daysAgo", { count: days });
    }
    if (days < 30) {
      return t("weeksAgo", { count: Math.floor(days / 7) });
    }
    return t("monthsAgo", { count: Math.floor(days / 30) });
  }

  function daysRemaining(ts: number | null): number {
    if (!ts) {
      return 0;
    }
    return Math.max(
      0,
      30 - Math.floor((Date.now() - ts) / (1000 * 60 * 60 * 24))
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between border-border border-b px-6 py-4">
        <div className="flex items-center gap-3">
          <button
            className="flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            onClick={() => navigate({ to: "/" })}
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <h1 className="font-[590] text-[16px] text-foreground">
              {t("recentlyDeletedTitle")}
            </h1>
            <p className="text-[12px] text-muted-foreground">
              {photos.length > 0
                ? t("trashSubtitle", { count: photos.length })
                : t("noDeletedPhotos")}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {selectedIds.size > 0 && (
            <>
              <button
                className="flex items-center gap-1.5 rounded-[6px] bg-primary/10 px-3 py-1.5 text-[13px] text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
                disabled={restoring}
                onClick={handleRestore}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t("restoreCount", { count: selectedIds.size })}
              </button>
              <button
                className="flex items-center gap-1.5 rounded-[6px] bg-destructive/10 px-3 py-1.5 text-[13px] text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-50"
                disabled={deleting}
                onClick={handlePermanentDelete}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t("permanentlyDelete")}
              </button>
            </>
          )}
          {photos.length > 0 && (
            <button
              className="rounded-[6px] px-3 py-1.5 text-[13px] text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
              disabled={deleting}
              onClick={handleEmptyTrash}
            >
              {t("emptyTrash")}
            </button>
          )}
        </div>
      </div>

      {/* Selection bar */}
      {photos.length > 0 && (
        <div className="flex items-center gap-3 border-border border-b px-6 py-2">
          <button
            className="text-[12px] text-muted-foreground hover:text-foreground"
            onClick={selectAll}
          >
            {selectedIds.size === photos.length
              ? t("deselectAll")
              : t("selectAll")}
          </button>
          {selectedIds.size > 0 && (
            <span className="text-[12px] text-muted-foreground">
              {t("selectedCount", { count: selectedIds.size })}
            </span>
          )}
        </div>
      )}

      {/* Photo grid */}
      <div
        className="relative flex-1 overflow-y-auto p-6"
        onClick={(e) => {
          if (marqueeJustCompleted.current) {
            marqueeJustCompleted.current = false;
            return;
          }
          const target = e.target as HTMLElement;
          if (!target.closest("[data-photo-id]")) {
            clearSelection();
          }
        }}
        onMouseDown={handleMarqueeStart}
        ref={scrollRef}
        style={{ userSelect: "none" }}
      >
        {/* Marquee selection overlay */}
        {marquee && (
          <div
            className="pointer-events-none absolute z-10 rounded-[4px] bg-primary/20 ring-1 ring-primary/40"
            style={{
              left: Math.min(marquee.startX, marquee.x),
              top: Math.min(marquee.startY, marquee.y),
              width: Math.abs(marquee.x - marquee.startX),
              height: Math.abs(marquee.y - marquee.startY),
            }}
          />
        )}
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-[14px] text-muted-foreground">{t("loading")}</p>
          </div>
        ) : photos.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <Trash2 className="h-12 w-12 text-muted-foreground/30" />
            <p className="text-[14px] text-muted-foreground">
              {t("trashEmpty")}
            </p>
            <p className="text-[12px] text-muted-foreground/60">
              {t("trashRetentionHint")}
            </p>
          </div>
        ) : (
          <div
            className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3"
            onContextMenu={handleContextMenu}
            role="grid"
          >
            {photos.map((photo) => (
              <div
                className={`group relative cursor-pointer overflow-hidden rounded-[8px] border transition-all ${
                  selectedIds.has(photo.id)
                    ? "border-primary ring-2 ring-primary/30"
                    : "border-border hover:border-foreground/20"
                }`}
                data-photo-id={photo.id}
                data-photo-path={photo.path}
                key={photo.id}
                onClick={(e) => toggleSelect(photo.id, e)}
                role="gridcell"
                tabIndex={0}
              >
                <div className="aspect-square bg-card">
                  {photo.thumbnailPath ? (
                    <img
                      alt={photo.filename}
                      className="h-full w-full object-cover opacity-60"
                      loading="lazy"
                      src={toLocalMediaUrl(photo.thumbnailPath)}
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-muted-foreground/30">
                      <Trash2 className="h-8 w-8" />
                    </div>
                  )}
                </div>
                <div className="p-2">
                  <p className="truncate text-[11px] text-foreground">
                    {photo.filename}
                  </p>
                  {photo.folderName ? (
                    <p className="truncate text-[10px] text-muted-foreground/70">
                      {photo.folderName}
                    </p>
                  ) : (
                    <p className="truncate text-[10px] text-orange-500/80">
                      {t("originalFolderRemoved")}
                    </p>
                  )}
                  <div className="mt-0.5 flex items-center justify-between">
                    <span className="text-[10px] text-muted-foreground">
                      {formatTimeAgo(photo.deletedAt)}
                    </span>
                    <span className="text-[10px] text-destructive/70">
                      {t("deleteAfterDays", {
                        count: daysRemaining(photo.deletedAt),
                      })}
                    </span>
                  </div>
                </div>
                {/* Selection indicator */}
                <div
                  className={`absolute top-2 left-2 flex h-5 w-5 items-center justify-center rounded-full border-2 transition-all ${
                    selectedIds.has(photo.id)
                      ? "border-primary bg-primary text-white"
                      : "border-white/60 bg-black/30 opacity-0 group-hover:opacity-100"
                  }`}
                >
                  {selectedIds.has(photo.id) && (
                    <svg
                      className="h-3 w-3"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        d="M5 13l4 4L19 7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={3}
                      />
                    </svg>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Context menu */}
      {ctxMenu.open && (
        <div
          className="fixed z-50 min-w-[180px] rounded-[8px] border border-border bg-popover p-1 ring-1 ring-foreground/5"
          id="trash-context-menu"
          style={{
            left: Math.min(ctxMenu.x, window.innerWidth - 190),
            top: Math.min(ctxMenu.y, window.innerHeight - 100),
          }}
        >
          <button
            className="flex w-full cursor-pointer items-center gap-2.5 rounded-[4px] px-3 py-1.5 text-[13px] text-foreground hover:bg-foreground/10"
            disabled={ctxMenu.photoId === null && !ctxMenu.isBatch}
            onClick={handleCtxRestore}
          >
            <RotateCcw className="h-3.5 w-3.5 flex-shrink-0" />
            {ctxMenu.isBatch
              ? `${t("restoreCount", { count: ctxMenu.selectionCount })}`
              : t("restoreCount", { count: 1 })}
          </button>
          <div className="my-1 h-px bg-border" />
          <button
            className="flex w-full cursor-pointer items-center gap-2.5 rounded-[4px] px-3 py-1.5 text-[13px] text-destructive hover:bg-foreground/10"
            disabled={ctxMenu.photoId === null && !ctxMenu.isBatch}
            onClick={handleCtxDelete}
          >
            <Trash2 className="h-3.5 w-3.5 flex-shrink-0" />
            {ctxMenu.isBatch
              ? `${t("permanentlyDelete")} (${ctxMenu.selectionCount})`
              : t("permanentlyDelete")}
          </button>
        </div>
      )}

      <ConfirmDialog
        confirmText={t("permanentlyDelete")}
        description={t("confirmPermanentDeleteDescription", {
          count: selectedIds.size,
        })}
        destructive
        disabled={deleting}
        onCancel={() => setConfirmPermanent(false)}
        onConfirm={performPermanentDelete}
        open={confirmPermanent}
        title={t("confirmPermanentDeleteTitle")}
      />
      <ConfirmDialog
        confirmText={t("emptyTrash")}
        description={t("confirmPermanentDeleteDescription", {
          count: photos.length,
        })}
        destructive
        disabled={deleting}
        onCancel={() => setConfirmEmpty(false)}
        onConfirm={performEmptyTrash}
        open={confirmEmpty}
        title={t("confirmEmptyTrashTitle")}
      />
    </div>
  );
}

export const Route = createFileRoute("/trash")({
  component: TrashPage,
});
