import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { PhotoGrid } from "@/components/PhotoGrid";
import { ipc } from "@/ipc/manager";
import type { Photo } from "@/types/photo";

interface FaceInfo {
  id: number;
  photoId: number;
  bboxX: number;
  bboxY: number;
  bboxWidth: number;
  bboxHeight: number;
}

interface IdentityDetail {
  id: number;
  name: string | null;
  faceCount: number;
  faces: FaceInfo[];
  photos: Photo[];
}

function PersonDetailPage() {
  const { identityId } = Route.useParams() as { identityId: string };
  const navigate = useNavigate();
  const [identity, setIdentity] = useState<IdentityDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");

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

  async function handleSaveName() {
    if (!identity || !nameInput.trim()) return;
    try {
      await ipc.client.faces.updateFaceIdentity({
        id: identity.id,
        name: nameInput.trim(),
      });
      setIdentity((prev) => (prev ? { ...prev, name: nameInput.trim() } : prev));
      setEditingName(false);
    } catch {
      /* ignore */
    }
  }

  async function handleRemoveFace(photoId: number) {
    if (!identity) return;
    const face = identity.faces.find((f) => f.photoId === photoId);
    if (!face) return;
    if (!confirm("确定将此照片从该人物分组中移除？")) return;
    try {
      const result = await ipc.client.faces.removeFaceFromIdentity({
        identityId: identity.id,
        faceVectorId: face.id,
      }) as { ok: boolean; remainingCount: number };
      if (result.remainingCount === 0) {
        navigate({ to: "/people" as "/people" });
      } else {
        loadIdentity();
      }
    } catch {
      /* ignore */
    }
  }

  const photos = identity?.photos || [];

  function toLocalMediaUrl(filePath: string): string {
    const encoded = filePath
      .replace(/\\/g, "/")
      .split("/")
      .map((s) => encodeURIComponent(s))
      .join("/");
    return `local-media://${encoded}`;
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center justify-between border-border border-b px-6 py-4">
        <div className="flex items-center gap-3">
          <button
            className="flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            onClick={() => navigate({ to: "/people" as "/people" })}
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
                  className="h-8 rounded-[6px] border border-input bg-card px-3 text-[16px] font-[590] text-foreground outline-none focus:border-primary"
                  onChange={(e) => setNameInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveName();
                    if (e.key === "Escape") setEditingName(false);
                  }}
                  value={nameInput}
                />
                <button
                  className="rounded-[4px] px-2 py-0.5 text-[11px] text-primary hover:bg-primary/10"
                  onClick={handleSaveName}
                >
                  保存
                </button>
              </div>
            ) : (
              <h1
                className="cursor-pointer font-[590] text-[20px] text-foreground tracking-tight hover:text-primary"
                onClick={() => setEditingName(true)}
              >
                {identity?.name || "未命名"}
              </h1>
            )}
            <p className="mt-0.5 text-[#6b6b75] text-[11px]">
              {photos.length} 张检测到该人物的照片
            </p>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div className="aspect-square animate-pulse rounded-[8px] bg-card" key={i} />
            ))}
          </div>
        ) : photos.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-[13px] text-muted-foreground">
            该人物分组中没有照片
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
            {photos.map((photo) => (
              <div className="group relative overflow-hidden rounded-[8px] border border-border bg-card" key={photo.id}>
                <div className="aspect-square overflow-hidden bg-muted">
                  {photo.thumbnailPath ? (
                    <img
                      alt={photo.filename}
                      className="h-full w-full object-cover"
                      src={toLocalMediaUrl(photo.thumbnailPath)}
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-[11px] text-muted-foreground">
                      {photo.filename}
                    </div>
                  )}
                </div>
                <div className="px-3 py-2">
                  <p className="truncate text-[12px] text-foreground">{photo.filename}</p>
                </div>
                <button
                  className="absolute top-2 right-2 flex h-7 w-7 items-center justify-center rounded-[4px] bg-black/60 text-white opacity-0 transition-opacity hover:bg-[#e5484d] group-hover:opacity-100"
                  onClick={() => handleRemoveFace(photo.id)}
                  title="从此人物分组中移除"
                  type="button"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/people/$identityId" as "/people/$identityId")({
  component: PersonDetailPage,
});
