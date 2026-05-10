import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/ipc/manager";

interface DupPhoto {
  filename: string;
  id: number;
  path: string;
}

interface DuplicatePair {
  distance: number;
  photoA: DupPhoto;
  photoB: DupPhoto;
}

function toLocalMediaUrl(filePath: string): string {
  const encoded = filePath
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `local-media://${encoded}`;
}

function DuplicatesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [pairs, setPairs] = useState<DuplicatePair[]>([]);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const loadDuplicates = useCallback(async () => {
    setLoading(true);
    try {
      const result = await ipc.client.photos.findDuplicates({ threshold: 8 });
      setPairs((result as { duplicates: DuplicatePair[] }).duplicates || []);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDuplicates();
  }, [loadDuplicates]);

  async function handleDelete(id: number) {
    setDeleting(true);
    try {
      await ipc.client.photos.deletePhoto({ id });
      setPairs((prev) =>
        prev.filter(
          (p) => p.photoA.id !== id && p.photoB.id !== id
        )
      );
    } catch {
      /* ignore */
    } finally {
      setDeleting(false);
    }
  }

  function handleDismiss(index: number) {
    setDismissed((prev) => new Set(prev).add(index));
  }

  async function handleDeleteAll() {
    setDeleting(true);
    const idsToDelete = new Set<number>();
    for (const pair of visiblePairs) {
      idsToDelete.add(pair.photoB.id);
    }
    try {
      await ipc.client.photos.deletePhotos({
        ids: Array.from(idsToDelete),
      });
      setPairs([]);
    } catch {
      /* ignore */
    } finally {
      setDeleting(false);
    }
  }

  const visiblePairs = pairs.filter((_, i) => !dismissed.has(i));

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#5e6ad2] border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between border-[rgba(255,255,255,0.06)] border-b px-6 py-4">
        <div className="flex items-center gap-4">
          <button
            className="text-[#a1a1aa] hover:text-[#f7f8f8]"
            onClick={() => navigate({ to: "/" })}
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <h1 className="font-[590] text-[#f7f8f8] text-[18px]">
            重复照片检测
          </h1>
          <span className="text-[#6b6b75] text-[13px]">
            {pairs.length} 组重复
          </span>
        </div>
        {visiblePairs.length > 0 && (
          <button
            className="flex items-center gap-1.5 rounded-[6px] border border-[rgba(255,255,255,0.08)] px-3 py-1.5 text-[#e5484d] text-[12px] transition-colors hover:border-[#e5484d]/30 hover:bg-[#e5484d]/5"
            disabled={deleting}
            onClick={handleDeleteAll}
          >
            <Trash2 className="h-3.5 w-3.5" />
            批量删除重复项
          </button>
        )}
      </div>

      {pairs.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <p className="font-[510] text-[#f7f8f8] text-[16px]">
              未发现重复照片
            </p>
            <p className="mt-2 text-[#6b6b75] text-[13px]">
              当索引的照片中存在视觉重复时将显示在此处
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-4 p-6">
          {visiblePairs.map((pair, i) => (
            <div
              className="overflow-hidden rounded-[8px] border border-[rgba(255,255,255,0.06)] bg-[#121214]"
              key={`${pair.photoA.id}-${pair.photoB.id}`}
            >
              {/* Pair header */}
              <div className="flex items-center justify-between border-[rgba(255,255,255,0.04)] border-b px-4 py-2">
                <span className="font-[510] text-[#a1a1aa] text-[11px]">
                  相似度: {Math.round((1 - pair.distance / 64) * 100)}%
                  &nbsp;&nbsp;汉明距离: {pair.distance}
                </span>
                <button
                  className="text-[#6b6b75] text-[11px] hover:text-[#a1a1aa]"
                  onClick={() => handleDismiss(i)}
                >
                  忽略
                </button>
              </div>
              {/* Side-by-side comparison */}
              <div className="grid grid-cols-2">
                {[pair.photoA, pair.photoB].map((photo, idx) => (
                  <div
                    className={`flex flex-col ${idx === 0 ? "border-[rgba(255,255,255,0.04)] border-r" : ""}`}
                    key={photo.id}
                  >
                    <div className="flex items-center justify-center bg-[#08090a] p-4">
                      <img
                        alt={photo.filename}
                        className="max-h-[250px] rounded-[4px] object-contain"
                        src={toLocalMediaUrl(photo.path)}
                      />
                    </div>
                    <div className="flex items-center justify-between border-[rgba(255,255,255,0.04)] border-t px-3 py-2">
                      <span className="truncate text-[#a1a1aa] text-[11px]">
                        {photo.filename}
                      </span>
                      <button
                        className="ml-2 flex-shrink-0 rounded-[4px] px-2 py-0.5 text-[#e5484d] text-[10px] transition-colors hover:bg-[#e5484d]/10"
                        disabled={deleting}
                        onClick={() => handleDelete(photo.id)}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute("/duplicates")({
  component: DuplicatesPage,
});
