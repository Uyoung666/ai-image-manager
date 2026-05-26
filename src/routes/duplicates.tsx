import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, CheckCircle2, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ipc } from "@/ipc/manager";
import { toLocalMediaUrl } from "@/utils/local-media-url";

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

function formatFileSize(bytes: number | null): string {
  if (!bytes) {
    return "—";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatResolution(w: number | null, h: number | null): string {
  if (!(w && h)) {
    return "—";
  }
  return `${w}×${h}`;
}

function getMatchLabel(
  type: "exact" | "phash" | "clip_confirmed",
  t: (key: string) => string
): {
  text: string;
  color: string;
} {
  switch (type) {
    case "exact":
      return { text: t("exactDuplicate"), color: "text-destructive bg-destructive/10" };
    case "clip_confirmed":
      return { text: t("visualDuplicate"), color: "text-warning bg-warning/10" };
    case "phash":
      return { text: t("highlySimilar"), color: "text-warning bg-warning/10" };
  }
}

function pickDeletion(
  pair: DuplicatePair,
  strategy: RetentionStrategy
): number | null {
  if (strategy === "manual") {
    return null;
  }
  const a = pair.photoA;
  const b = pair.photoB;
  if (strategy === "larger") {
    return (a.fileSize ?? 0) >= (b.fileSize ?? 0) ? b.id : a.id;
  }
  // "older" — keep the older one (smaller createdAt), delete the newer
  return a.createdAt <= b.createdAt ? b.id : a.id;
}

function DuplicatesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [pairs, setPairs] = useState<DuplicatePair[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [strategy, setStrategy] = useState<RetentionStrategy>("manual");
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const loadDuplicates = useCallback(async (forceRescan = false) => {
    if (forceRescan) {
      setScanning(true);
    } else {
      setLoading(true);
    }
    try {
      const result = await ipc.client.photos.findDuplicates({
        threshold: 8,
        forceRescan,
      });
      const data = result as {
        duplicates: DuplicatePair[];
        fromCache: boolean;
      };
      setPairs(data.duplicates || []);
      setSelected(new Set());
    } catch (err) {
      console.error("[loadDuplicates] failed:", err);
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
      if (p.matchType === "exact") {
        exact.push(p);
      } else if (p.matchType === "clip_confirmed") {
        clipConfirmed.push(p);
      } else {
        phash.push(p);
      }
    }
    return { exact, clipConfirmed, phash };
  }, [pairs]);

  function toggleSelect(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
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
      if (toDelete) {
        newSelected.add(toDelete);
      }
    }
    setSelected(newSelected);
  }, [strategy, pairs]);

  async function handleDismiss(pair: DuplicatePair) {
    if (pair.pairId) {
      try {
        await ipc.client.photos.dismissDuplicate({ pairId: pair.pairId });
      } catch (err) {
        console.error("[handleDismiss] failed:", err);
      }
    }
    setPairs((prev) => prev.filter((p) => p !== pair));
  }

  async function handleDeleteSelected() {
    if (selected.size === 0) {
      return;
    }
    setDeleting(true);
    try {
      await ipc.client.photos.deletePhotos({ ids: Array.from(selected) });
      setPairs((prev) =>
        prev.filter(
          (p) => !(selected.has(p.photoA.id) || selected.has(p.photoB.id))
        )
      );
      setSelected(new Set());
    } catch {
      toast.error(t("duplicateDeleteFailed"));
    } finally {
      setDeleting(false);
    }
  }

  async function handleDeleteSingle(id: number) {
    setDeleting(true);
    try {
      await ipc.client.photos.deletePhoto({ id });
      setPairs((prev) =>
        prev.filter((p) => p.photoA.id !== id && p.photoB.id !== id)
      );
      setSelected((prev) => {
        const n = new Set(prev);
        n.delete(id);
        return n;
      });
    } catch {
      toast.error(t("duplicateDeleteFailed"));
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between border-border border-b px-6 py-4">
        <div className="flex items-center gap-4">
          <button
            className="text-muted-foreground hover:text-foreground"
            onClick={() => navigate({ to: "/" })}
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <h1 className="font-[590] text-[18px] text-foreground">
            {t("duplicatesTitle")}
          </h1>
          <span className="text-[13px] text-muted-foreground/70">
            {t("duplicateGroups", { count: pairs.length })}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <button
            className="flex items-center gap-1.5 rounded-[6px] border border-input px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
            disabled={scanning}
            onClick={() => loadDuplicates(true)}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${scanning ? "animate-spin" : ""}`}
            />
            {t("rescan")}
          </button>
          {selected.size > 0 && (
            <button
              className="flex items-center gap-1.5 rounded-[6px] border border-input px-3 py-1.5 text-[12px] text-destructive transition-colors hover:border-destructive/30 hover:bg-destructive/5"
              disabled={deleting}
              onClick={handleDeleteSelected}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t("deleteSelectedCount", { count: selected.size })}
            </button>
          )}
        </div>
      </div>

      {/* Strategy selector */}
      {pairs.length > 0 && (
        <div className="flex items-center gap-3 border-border border-b px-6 py-3">
          <span className="text-[12px] text-muted-foreground/70">
            {t("retentionStrategy")}
          </span>
          {(
            [
              ["manual", t("manualSelection")],
              ["larger", t("keepLargerFile")],
              ["older", t("keepOlderCreated")],
            ] as const
          ).map(([key, label]) => (
            <button
              className={`rounded-[6px] px-2.5 py-1 text-[11px] transition-colors ${
                strategy === key
                  ? "bg-primary/10 font-[510] text-primary"
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

      <div className="flex-1 overflow-y-auto">
        {pairs.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <CheckCircle2 className="mx-auto h-10 w-10 text-success/60" />
              <p className="mt-3 font-[510] text-[16px] text-foreground">
                {t("noDuplicatesTitle")}
              </p>
              <p className="mt-2 text-[13px] text-muted-foreground/70">
                {t("noDuplicatesDescription")}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-6 p-6">
          {/* Grouped sections */}
          {(
            [
              ["exact", grouped.exact, t("exactDuplicate")],
              ["clip_confirmed", grouped.clipConfirmed, t("visualDuplicate")],
              ["phash", grouped.phash, t("highlySimilar")],
            ] as const
          ).map(([key, items, title]) => {
            if (items.length === 0) {
              return null;
            }
            const label = getMatchLabel(key, t);
            return (
              <div key={key}>
                <div className="mb-3 flex items-center gap-2">
                  <span
                    className={`rounded-[4px] px-2 py-0.5 font-[510] text-[11px] ${label.color}`}
                  >
                    {title}
                  </span>
                  <span className="text-[11px] text-muted-foreground/70">
                    {t("duplicateGroups", { count: items.length })}
                  </span>
                </div>
                <div className="space-y-3">
                  {items.map((pair) => (
                    <PairCard
                      deleting={deleting}
                      key={`${pair.photoA.id}-${pair.photoB.id}`}
                      onDelete={handleDeleteSingle}
                      onDismiss={() => handleDismiss(pair)}
                      onToggle={toggleSelect}
                      pair={pair}
                      selected={selected}
                      t={t}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
      </div>
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
  t,
}: {
  pair: DuplicatePair;
  selected: Set<number>;
  onToggle: (id: number) => void;
  onDelete: (id: number) => void;
  onDismiss: () => void;
  deleting: boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const label = getMatchLabel(pair.matchType, t);

  return (
    <div className="overflow-hidden rounded-[8px] border border-border bg-secondary">
      <div className="flex items-center justify-between border-border border-b px-4 py-2">
        <div className="flex items-center gap-3">
          <span
            className={`rounded-[4px] px-1.5 py-0.5 font-[510] text-[10px] ${label.color}`}
          >
            {label.text}
          </span>
          {pair.matchType !== "exact" && (
            <span className="text-[10px] text-muted-foreground/70">
              {t("hammingDistance", { distance: pair.distance })}
            </span>
          )}
          {pair.clipSimilarity != null && (
            <span className="text-[10px] text-success">
              CLIP: {Math.round(pair.clipSimilarity * 100)}%
            </span>
          )}
        </div>
        <button
          className="text-[11px] text-muted-foreground/70 hover:text-muted-foreground"
          onClick={onDismiss}
        >
          {t("ignore")}
        </button>
      </div>
      <div className="grid grid-cols-2">
        {[pair.photoA, pair.photoB].map((photo, idx) => {
          const isSelected = selected.has(photo.id);
          return (
            <div
              className={`flex flex-col ${idx === 0 ? "border-border border-r" : ""} ${isSelected ? "bg-destructive/5" : ""}`}
              key={photo.id}
            >
              <div className="relative flex items-center justify-center bg-background p-4">
                <img
                  alt={photo.filename}
                  className="max-h-[220px] rounded-[4px] object-contain"
                  src={toLocalMediaUrl(photo.path)}
                />
                {isSelected && (
                  <div className="absolute top-2 right-2 rounded-full bg-destructive px-2 py-0.5 font-[510] text-[10px] text-white">
                    {t("pendingDelete")}
                  </div>
                )}
              </div>
              <div className="border-border border-t px-3 py-2">
                <div className="flex items-center justify-between">
                  <span className="truncate text-[11px] text-muted-foreground">
                    {photo.filename}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-3 text-[10px] text-muted-foreground/70">
                  <span>{formatFileSize(photo.fileSize)}</span>
                  <span>{formatResolution(photo.width, photo.height)}</span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    className={`rounded-[4px] px-2 py-0.5 text-[10px] transition-colors ${
                      isSelected
                        ? "bg-destructive/10 font-[510] text-destructive"
                        : "text-muted-foreground hover:bg-muted"
                    }`}
                    onClick={() => onToggle(photo.id)}
                  >
                    {isSelected ? t("deselect") : t("selectDelete")}
                  </button>
                  <button
                    className="rounded-[4px] px-2 py-0.5 text-[10px] text-destructive transition-colors hover:bg-destructive/10"
                    disabled={deleting}
                    onClick={() => onDelete(photo.id)}
                  >
                    {t("deleteNow")}
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
