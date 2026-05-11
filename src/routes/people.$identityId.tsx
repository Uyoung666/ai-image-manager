import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { PhotoGrid } from "@/components/PhotoGrid";
import { ipc } from "@/ipc/manager";

interface PhotoInfo {
  filename: string;
  fileSize: number;
  height: number;
  id: number;
  path: string;
  thumbnailPath: string | null;
  width: number;
}

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
  photos: PhotoInfo[];
}

function PersonDetailPage() {
  const { identityId } = Route.useParams() as any as { identityId: string };
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

  const photos = identity?.photos || [];

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center justify-between border-border border-b px-6 py-4">
        <div className="flex items-center gap-3">
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
              {identity?.faceCount ?? 0} 张检测到该人物的照片
            </p>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <PhotoGrid
          loading={loading}
          onContextMenu={() => {}}
          onDoubleClick={() => {}}
          onSelect={() => {}}
          photos={photos}
          selectedIds={new Set()}
        />
      </div>
    </div>
  );
}

export const Route = createFileRoute("/people/$identityId" as any)({
  component: PersonDetailPage,
});
