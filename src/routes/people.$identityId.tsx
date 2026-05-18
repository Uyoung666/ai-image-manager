import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PhotoGrid } from "@/components/PhotoGrid";
import { PhotoLightbox } from "@/components/PhotoLightbox";
import { SelectionActionBar } from "@/components/SelectionActionBar";
import { ipc } from "@/ipc/manager";
import { queryClient } from "@/providers/QueryProvider";
import type { Photo } from "@/types/photo";

interface FaceInfo {
  bboxHeight: number;
  bboxWidth: number;
  bboxX: number;
  bboxY: number;
  id: number;
  photoId: number;
}

interface IdentityDetail {
  faceCount: number;
  faces: FaceInfo[];
  id: number;
  name: string | null;
  photos: Photo[];
}

interface CtxMenu {
  open: boolean;
  photoId: number | null;
  photoPath: string | null;
  x: number;
  y: number;
}

function PersonDetailPage() {
  const { t } = useTranslation();
  const { identityId } = Route.useParams() as { identityId: string };
  const navigate = useNavigate();
  const [identity, setIdentity] = useState<IdentityDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [ctxMenu, setCtxMenu] = useState<CtxMenu>({
    open: false,
    photoId: null,
    photoPath: null,
    x: 0,
    y: 0,
  });
  const menuRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const [lightboxIndex, setLightboxIndex] = useState(-1);
  const [confirmRemovePhotoId, setConfirmRemovePhotoId] = useState<number | null>(
    null
  );
  const [allFavorite, setAllFavorite] = useState(false);
  const [confirmDeleteIds, setConfirmDeleteIds] = useState<number[]>([]);


  const loadIdentity = useCallback(async () => {
    try {
      const result = await ipc.client.faces.getFaceIdentity({
        id: Number(identityId),
      });
      const data = result as unknown as IdentityDetail;
      setIdentity(data);
      setNameInput(data.name || "");
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [identityId]);

  useEffect(() => {
    loadIdentity();
  }, [loadIdentity]);

  useEffect(() => {
    if (!ctxMenu.open) {
      return;
    }
    const dismiss = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setCtxMenu((m) => ({ ...m, open: false }));
      }
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setCtxMenu((m) => ({ ...m, open: false }));
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", dismiss, true);
      document.addEventListener("contextmenu", dismiss, true);
    }, 0);
    document.addEventListener("keydown", keyHandler);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", dismiss, true);
      document.removeEventListener("contextmenu", dismiss, true);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [ctxMenu.open]);

  async function handleSaveName() {
    if (!(identity && nameInput.trim())) {
      return;
    }
    try {
      await ipc.client.faces.updateFaceIdentity({
        id: identity.id,
        name: nameInput.trim(),
      });
      setIdentity((prev) =>
        prev ? { ...prev, name: nameInput.trim() } : prev
      );
      setEditingName(false);
    } catch {
      /* ignore */
    }
  }

  function handleRemoveFace(photoId: number) {
    if (!identity) {
      return;
    }
    const face = identity.faces.find((f) => f.photoId === photoId);
    if (!face) {
      return;
    }
    setConfirmRemovePhotoId(photoId);
  }

  async function performRemoveFace() {
    if (!(identity && confirmRemovePhotoId !== null)) {
      return;
    }
    const face = identity.faces.find((f) => f.photoId === confirmRemovePhotoId);
    setConfirmRemovePhotoId(null);
    if (!face) {
      return;
    }
    try {
      const result = (await ipc.client.faces.removeFaceFromIdentity({
        identityId: identity.id,
        faceVectorId: face.id,
      })) as { ok: boolean; remainingCount: number };
      if (result.remainingCount === 0) {
        navigate({ to: "/people" as const });
      } else {
        loadIdentity();
      }
    } catch {
      /* ignore */
    }
  }

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    const target = (e.target as HTMLElement).closest(
      "[data-photo-id]"
    ) as HTMLElement | null;
    if (!target) {
      return;
    }
    const photoId = Number(target.dataset.photoId);
    const photoPath = target.dataset.photoPath || null;
    setCtxMenu({ open: true, photoId, photoPath, x: e.clientX, y: e.clientY });
  }

  async function handleFavoriteSelected() {
    const ids = Array.from(selectedIds);
    const nextFav = !allFavorite;
    try {
      await ipc.client.photos.toggleFavorite({ ids, favorite: nextFav });
    } catch {
      /* skip */
    }
    setAllFavorite(nextFav);
    queryClient.invalidateQueries({ queryKey: ["photos"] });
  }

  async function handleDeleteSelected() {
    setConfirmDeleteIds(Array.from(selectedIds));
  }

  async function performDelete() {
    try {
      await ipc.client.photos.deletePhotos({ ids: confirmDeleteIds });
      toast.success(t("deletedPhotosCount", { count: confirmDeleteIds.length }));
      setIdentity((prev) =>
        prev
          ? {
              ...prev,
              photos: prev.photos.filter((p) => !confirmDeleteIds.includes(p.id)),
            }
          : prev
      );
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["photos"] });
      queryClient.invalidateQueries({ queryKey: ["folders"] });
    } catch {
      toast.error(t("deleteFailed"));
    } finally {
      setConfirmDeleteIds([]);
    }
  }

  function handleSelect(id: number, event: React.MouseEvent) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (event.ctrlKey || event.metaKey) {
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
      } else {
        next.clear();
        next.add(id);
      }
      return next;
    });
  }

  function handleDoubleClick(id: number) {
    const idx = photos.findIndex((p) => p.id === id);
    if (idx >= 0) {
      setLightboxIndex(idx);
    }
  }

  function handleOpenExplorer(path: string) {
    ipc.client.shell.openInExplorer({ path }).catch(() => {});
  }

  const photos = identity?.photos || [];

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center justify-between border-border border-b px-6 py-4">
        <div className="flex items-center gap-3">
          <button
            className="flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            onClick={() => navigate({ to: "/people" as const })}
            type="button"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <span className="font-[590] text-[18px] text-muted-foreground">
              {(identity?.name || "?")[0]}
            </span>
          </div>
          <div>
            {editingName ? (
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  className="h-8 rounded-[6px] border border-input bg-card px-3 font-[590] text-[16px] text-foreground outline-none focus:border-primary"
                  onChange={(e) => setNameInput(e.target.value)}
                  onCompositionEnd={(e) => {
                    composingRef.current = false;
                    setNameInput((e.target as HTMLInputElement).value);
                  }}
                  onCompositionStart={() => {
                    composingRef.current = true;
                  }}
                  onKeyDown={(e) => {
                    if (composingRef.current) {
                      return;
                    }
                    if (e.key === "Enter") {
                      handleSaveName();
                    }
                    if (e.key === "Escape") {
                      setEditingName(false);
                    }
                  }}
                  value={nameInput}
                />
                <button
                  className="rounded-[4px] px-2 py-0.5 text-[11px] text-primary hover:bg-primary/10"
                  onClick={handleSaveName}
                  type="button"
                >
                  {t("save")}
                </button>
              </div>
            ) : (
              <h1
                className="cursor-pointer font-[590] text-[20px] text-foreground tracking-tight hover:text-primary"
                onClick={() => setEditingName(true)}
              >
                {identity?.name || t("unnamedPerson")}
              </h1>
            )}
            <p className="mt-0.5 text-[11px] text-muted-foreground/70">
              {t("detectedPersonPhotos", { count: photos.length })}
            </p>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <PhotoGrid
          loading={loading}
          onContextMenu={handleContextMenu}
          onDoubleClick={handleDoubleClick}
          onSelect={handleSelect}
          photos={photos as any}
          selectedIds={selectedIds}
        />
      </div>

      {lightboxIndex >= 0 && (
        <PhotoLightbox
          index={lightboxIndex}
          onClose={() => setLightboxIndex(-1)}
          open={lightboxIndex >= 0}
          photos={photos as any}
        />
      )}

      {ctxMenu.open && (
        <div
          className="fixed z-50 min-w-[180px] rounded-[8px] border border-border bg-popover p-1 ring-1 ring-foreground/5"
          ref={menuRef}
          style={{
            left: Math.min(ctxMenu.x, window.innerWidth - 190),
            top: Math.min(ctxMenu.y, window.innerHeight - 180),
          }}
        >
          <button
            className="flex w-full cursor-default items-center gap-2 rounded-[4px] px-3 py-1.5 text-[13px] text-foreground hover:bg-foreground/10"
            onClick={() => {
              if (ctxMenu.photoPath) {
                handleOpenExplorer(ctxMenu.photoPath);
              }
              setCtxMenu((m) => ({ ...m, open: false }));
            }}
          >
            {t("openInExplorer")}
          </button>
          <button
            className="flex w-full cursor-default items-center gap-2 rounded-[4px] px-3 py-1.5 text-[13px] text-foreground hover:bg-foreground/10"
            onClick={() => {
              if (ctxMenu.photoPath) {
                navigator.clipboard
                  .writeText(ctxMenu.photoPath)
                  .catch(() => {});
              }
              setCtxMenu((m) => ({ ...m, open: false }));
            }}
          >
            {t("copyPath")}
          </button>
          <div className="my-1 h-px bg-border" />
          <button
            className="flex w-full cursor-default items-center gap-2 rounded-[4px] px-3 py-1.5 text-[13px] text-destructive hover:bg-foreground/10"
            onClick={() => {
              if (ctxMenu.photoId !== null) {
                handleRemoveFace(ctxMenu.photoId);
              }
              setCtxMenu((m) => ({ ...m, open: false }));
            }}
          >
            {t("removeFromPerson")}
          </button>
        </div>
      )}

      <SelectionActionBar
        allFavorite={allFavorite}
        onClearSelection={() => setSelectedIds(new Set())}
        onDelete={handleDeleteSelected}
        onToggleFavorite={handleFavoriteSelected}
        selectedCount={selectedIds.size}
      />

      <ConfirmDialog
        confirmText={t("remove")}
        description={t("removeFromPersonDescription")}
        destructive
        onCancel={() => setConfirmRemovePhotoId(null)}
        onConfirm={performRemoveFace}
        open={confirmRemovePhotoId !== null}
        title={t("confirmRemove")}
      />
      <ConfirmDialog
        confirmText={t("delete")}
        description={t("confirmDeleteDescription", { count: confirmDeleteIds.length })}
        destructive
        onCancel={() => setConfirmDeleteIds([])}
        onConfirm={performDelete}
        open={confirmDeleteIds.length > 0}
        title={t("confirmDeleteTitle")}
      />
    </div>
  );
}

export const Route = createFileRoute("/people/$identityId" as const)({
  component: PersonDetailPage,
});
