import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, CheckCircle2, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ipc } from "@/ipc/manager";

interface DupPhoto {
  createdAt: number;
  filename: string;
  fileSize: number | null;
  height: number | null;
  id: number;
  path: string;
  width: number | null;
}

interface DuplicatePair {
  clipSimilarity?: number | null;
  distance: number;
  matchType: "exact" | "phash" | "clip_confirmed";
  pairId: number | null;
  photoA: DupPhoto;
  photoB: DupPhoto;
  status: "pending" | "confirmed";
}

type RetentionStrategy = "larger" | "older" | "manual";

function toLocalMediaUrl(filePath: string): string {
  const encoded = filePath
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `local-media://${encoded}`;
}

function formatFileSize(bytes: number | null): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatResolution(w: number | null, h: number | null): string {
  if (!w || !h) return "—";
  return `${w}×${h}`;
}

function getMatchLabel(type: "exact" | "phash" | "clip_confirmed"): { text: string; color: string } {
  switch (type) {
    case "exact":
      return { text: "完全相同", color: "text-[#e5484d] bg-[#e5484d]/10" };
    case "clip_confirmed":
      return { text: "视觉相同", color: "text-[#e5934a] bg-[#e5934a]/10" };
    case "phash":
      return { text: "高度相似", color: "text-[#f5d90a] bg-[#f5d90a]/10" };
  }
}

function pickDeletion(pair: DuplicatePair, strategy: RetentionStrategy): number | null {
  if (strategy === "manual") return null;
  const a = pair.photoA;
  const b = pair.photoB;
  if (strategy === "larger") {
    return (a.fileSize ?? 0) >= (b.fileSize ?? 0) ? b.id : a.id;
  }
  // "older" — keep the older one (smaller createdAt), delete the newer
  return a.createdAt <= b.createdAt ? b.id : a.id;
}

function DuplicatesPage() {
  const navigate = useNavigate();
  const [pairs, setPairs] = useState<DuplicatePair[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [strategy, setStrategy] = useState<RetentionStrategy>("manual");
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const loadDuplicates = useCallback(async (forceRescan = false) => {
    if (forceRescan) setScanning(true);
    else setLoading(true);
    try {
      const result = await ipc.client.photos.findDuplicates({
        threshold: 8,
        forceRescan,
      });
      const data = result as { duplicates: DuplicatePair[]; fromCache: boolean };
      setPairs(data.duplicates || []);
      setSelected(new Set());
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    loadDuplicates();
  }, [loadDuplicates]);

  const grouped = useMemo(() => {
    const exact: DuplicatePair[] = [];
    const clipConfirmed: DuplicatePair[] = [];
    const phash: DuplicatePair[] = [];
    for (const p of pairs) {
      if (p.matchType === "exact") exact.push(p);
      else if (p.matchType === "clip_confirmed") clipConfirmed.push(p);
      else phash.push(p);
    }
    return { exact, clipConfirmed, phash };
  }, [pairs]);

  function toggleSelect(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  useEffect(() => {
    if (strategy === "manual") {
      setSelected(new Set());
      return;
    }
    const newSelected = new Set<number>();
    for (const pair of pairs) {
      const toDelete = pickDeletion(pair, strategy);
      if (toDelete) newSelected.add(toDelete);
    }
    setSelected(newSelected);
  }, [strategy, pairs]);

  async function handleDismiss(pair: DuplicatePair) {
    if (pair.pairId) {
      try {
        await ipc.client.photos.dismissDuplicate({ pairId: pair.pairId });
      } catch { /* ignore */ }
    }
    setPairs((prev) => prev.filter((p) => p !== pair));
  }

  async function handleDeleteSelected() {
    if (selected.size === 0) return;
    setDeleting(true);
    try {
      await ipc.client.photos.deletePhotos({ ids: Array.from(selected) });
      setPairs((prev) =>
        prev.filter(
          (p) => !selected.has(p.photoA.id) && !selected.has(p.photoB.id)
        )
      );
      setSelected(new Set());
    } catch { /* ignore */ }
    finally { setDeleting(false); }
  }

  async function handleDeleteSingle(id: number) {
    setDeleting(true);
    try {
      await ipc.client.photos.deletePhoto({ id });
      setPairs((prev) =>
        prev.filter((p) => p.photoA.id !== id && p.photoB.id !== id)
      );
      setSelected((prev) => { const n = new Set(prev); n.delete(id); return n; });
    } catch { /* ignore */ }
    finally { setDeleting(false); }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between border-border border-b px-6 py-4">
        <div className="flex items-center gap-4">
          <button
            className="text-muted-foreground hover:text-foreground"
            onClick={() => navigate({ to: "/" })}
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <h1 className="font-[590] text-foreground text-[18px]">
            重复照片检测
          </h1>
          <span className="text-[#6b6b75] text-[13px]">
            {pairs.length} 组重复
          </span>
        </div>
        <div className="flex items-center gap-3">
          <button
            className="flex items-center gap-1.5 rounded-[6px] border border-input px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
            disabled={scanning}
            onClick={() => loadDuplicates(true)}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${scanning ? "animate-spin" : ""}`} />
            重新扫描
          </button>
          {selected.size > 0 && (
            <button
              className="flex items-center gap-1.5 rounded-[6px] border border-input px-3 py-1.5 text-[#e5484d] text-[12px] transition-colors hover:border-[#e5484d]/30 hover:bg-[#e5484d]/5"
              disabled={deleting}
              onClick={handleDeleteSelected}
            >
              <Trash2 className="h-3.5 w-3.5" />
              删除选中 ({selected.size})
            </button>
          )}
        </div>
      </div>

      {/* Strategy selector */}
      {pairs.length > 0 && (
        <div className="flex items-center gap-3 border-border border-b px-6 py-3">
          <span className="text-[#6b6b75] text-[12px]">保留策略:</span>
          {([
            ["manual", "手动选择"],
            ["larger", "保留更大文件"],
            ["older", "保留更早创建"],
          ] as const).map(([key, label]) => (
            <button
              className={`rounded-[6px] px-2.5 py-1 text-[11px] transition-colors ${
                strategy === key
                  ? "bg-primary/10 text-primary font-[510]"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              key={key}
              onClick={() => setStrategy(key)}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {pairs.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <CheckCircle2 className="mx-auto h-10 w-10 text-[#46a758]/60" />
            <p className="mt-3 font-[510] text-foreground text-[16px]">
              未发现重复照片
            </p>
            <p className="mt-2 text-[#6b6b75] text-[13px]">
              当索引的照片中存在视觉重复时将显示在此处
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-6 p-6">
          {/* Grouped sections */}
          {([
            ["exact", grouped.exact, "完全相同"],
            ["clip_confirmed", grouped.clipConfirmed, "视觉相同"],
            ["phash", grouped.phash, "高度相似"],
          ] as const).map(([key, items, title]) => {
            if (items.length === 0) return null;
            const label = getMatchLabel(key);
            return (
              <div key={key}>
                <div className="mb-3 flex items-center gap-2">
                  <span className={`rounded-[4px] px-2 py-0.5 text-[11px] font-[510] ${label.color}`}>
                    {title}
                  </span>
                  <span className="text-[#6b6b75] text-[11px]">{items.length} 组</span>
                </div>
                <div className="space-y-3">
                  {items.map((pair) => (
                    <PairCard
                      key={`${pair.photoA.id}-${pair.photoB.id}`}
                      deleting={deleting}
                      onDelete={handleDeleteSingle}
                      onDismiss={() => handleDismiss(pair)}
                      onToggle={toggleSelect}
                      pair={pair}
                      selected={selected}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PairCard({
  pair,
  selected,
  onToggle,
  onDelete,
  onDismiss,
  deleting,
}: {
  pair: DuplicatePair;
  selected: Set<number>;
  onToggle: (id: number) => void;
  onDelete: (id: number) => void;
  onDismiss: () => void;
  deleting: boolean;
}) {
  const label = getMatchLabel(pair.matchType);

  return (
    <div className="overflow-hidden rounded-[8px] border border-border bg-secondary">
      <div className="flex items-center justify-between border-border border-b px-4 py-2">
        <div className="flex items-center gap-3">
          <span className={`rounded-[4px] px-1.5 py-0.5 text-[10px] font-[510] ${label.color}`}>
            {label.text}
          </span>
          {pair.matchType !== "exact" && (
            <span className="text-[#6b6b75] text-[10px]">
              汉明距离: {pair.distance}
            </span>
          )}
          {pair.clipSimilarity != null && (
            <span className="text-[#46a758] text-[10px]">
              CLIP: {Math.round(pair.clipSimilarity * 100)}%
            </span>
          )}
        </div>
        <button
          className="text-[#6b6b75] text-[11px] hover:text-muted-foreground"
          onClick={onDismiss}
        >
          忽略
        </button>
      </div>
      <div className="grid grid-cols-2">
        {[pair.photoA, pair.photoB].map((photo, idx) => {
          const isSelected = selected.has(photo.id);
          return (
            <div
              className={`flex flex-col ${idx === 0 ? "border-border border-r" : ""} ${isSelected ? "bg-[#e5484d]/5" : ""}`}
              key={photo.id}
            >
              <div className="relative flex items-center justify-center bg-background p-4">
                <img
                  alt={photo.filename}
                  className="max-h-[220px] rounded-[4px] object-contain"
                  src={toLocalMediaUrl(photo.path)}
                />
                {isSelected && (
                  <div className="absolute top-2 right-2 rounded-full bg-[#e5484d] px-2 py-0.5 text-[10px] text-white font-[510]">
                    待删除
                  </div>
                )}
              </div>
              <div className="border-border border-t px-3 py-2">
                <div className="flex items-center justify-between">
                  <span className="truncate text-muted-foreground text-[11px]">
                    {photo.filename}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-3 text-[10px] text-[#6b6b75]">
                  <span>{formatFileSize(photo.fileSize)}</span>
                  <span>{formatResolution(photo.width, photo.height)}</span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    className={`rounded-[4px] px-2 py-0.5 text-[10px] transition-colors ${
                      isSelected
                        ? "bg-[#e5484d]/10 text-[#e5484d] font-[510]"
                        : "text-muted-foreground hover:bg-muted"
                    }`}
                    onClick={() => onToggle(photo.id)}
                  >
                    {isSelected ? "取消选中" : "选中删除"}
                  </button>
                  <button
                    className="rounded-[4px] px-2 py-0.5 text-[#e5484d] text-[10px] transition-colors hover:bg-[#e5484d]/10"
                    disabled={deleting}
                    onClick={() => onDelete(photo.id)}
                  >
                    立即删除
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/duplicates")({
  component: DuplicatesPage,
});
