import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowLeft, CheckCircle2, RefreshCw, Trash2 } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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

// ──────────────────────────────────────────────────────────────
// Row type for virtual scrolling: header or pair
// ──────────────────────────────────────────────────────────────

type DuplicateRow =
  | {
      type: "header";
      key: string;
      title: string;
      label: { text: string; color: string };
      count: number;
    }
  | { type: "pair"; pair: DuplicatePair; pairKey: string };

// ──────────────────────────────────────────────────────────────
// Helpers (module-level — no dependency on component state)
// ──────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────
// PairCard — memo'd for virtual scrolling stability
// ──────────────────────────────────────────────────────────────

const PairCard = memo(function PairCard({
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
              <div className="relative flex min-h-[220px] items-center justify-center bg-background p-4">
                <img
                  alt={photo.filename}
                  className="max-h-[220px] rounded-[4px] object-contain"
                  loading="lazy"
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
});

// ──────────────────────────────────────────────────────────────
// DuplicatesPage — main component
// ──────────────────────────────────────────────────────────────

function DuplicatesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [deleting, setDeleting] = useState(false);
  const [strategy, setStrategy] = useState<RetentionStrategy>("manual");
  const [selected, setSelected] = useState<Set<number>>(new Set());

  // ── TanStack Query: duplicates data ──

  const {
    data: pairsData,
    isLoading: loading,
  } = useQuery({
    queryKey: ["duplicates"],
    queryFn: async () => {
      const result = await ipc.client.photos.findDuplicates({
        threshold: 8,
        forceRescan: false,
      });
      return result as {
        duplicates: DuplicatePair[];
        fromCache: boolean;
      };
    },
    staleTime: 30_000,
  });

  const pairs = pairsData?.duplicates || [];

  // ── Local scanning state (for rescan spinner) ──

  const [scanning, setScanning] = useState(false);

  const handleRescan = useCallback(async () => {
    setScanning(true);
    try {
      const result = await ipc.client.photos.findDuplicates({
        threshold: 8,
        forceRescan: true,
      });
      queryClient.setQueryData(["duplicates"], result);
    } catch (err) {
      console.error("[handleRescan] failed:", err);
    } finally {
      setScanning(false);
    }
  }, [queryClient]);

  // ── Grouped pairs → flattened rows for virtualizer ──

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

  const allRows = useMemo((): DuplicateRow[] => {
    const rows: DuplicateRow[] = [];
    const sections = [
      ["exact", grouped.exact, t("exactDuplicate")],
      ["clip_confirmed", grouped.clipConfirmed, t("visualDuplicate")],
      ["phash", grouped.phash, t("highlySimilar")],
    ] as const;
    for (const [key, items, title] of sections) {
      if (items.length === 0) continue;
      const label = getMatchLabel(key, t);
      rows.push({ type: "header", key, title, label, count: items.length });
      for (const pair of items) {
        rows.push({
          type: "pair",
          pair,
          pairKey: `${pair.photoA.id}-${pair.photoB.id}`,
        });
      }
    }
    return rows;
  }, [grouped, t]);

  // ── useVirtualizer ──

  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: allRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => (allRows[index].type === "header" ? 36 : 355),
    getItemKey: (index) => {
      const row = allRows[index];
      return row.type === "header" ? `h-${row.key}` : `p-${row.pairKey}`;
    },
    overscan: 5,
  });

  // ── Selection & filters ──

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

  // ── Dismiss (ignore) a pair — optimistic update ──

  async function handleDismiss(pair: DuplicatePair) {
    if (pair.pairId) {
      try {
        await ipc.client.photos.dismissDuplicate({ pairId: pair.pairId });
      } catch (err) {
        console.error("[handleDismiss] failed:", err);
      }
    }
    // Optimistic: remove from query cache
    queryClient.setQueryData<{ duplicates: DuplicatePair[]; fromCache?: boolean }>(
      ["duplicates"],
      (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          duplicates: prev.duplicates.filter(
            (p) =>
              !(
                p.photoA.id === pair.photoA.id && p.photoB.id === pair.photoB.id
              )
          ),
        };
      },
    );
  }

  // ── Delete selected ──

  async function handleDeleteSelected() {
    if (selected.size === 0) {
      return;
    }
    setDeleting(true);
    try {
      await ipc.client.photos.deletePhotos({ ids: Array.from(selected) });
      // Optimistic: remove affected pairs from query cache
      queryClient.setQueryData<{ duplicates: DuplicatePair[]; fromCache?: boolean }>(
        ["duplicates"],
        (prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            duplicates: prev.duplicates.filter(
              (p) => !(selected.has(p.photoA.id) || selected.has(p.photoB.id))
            ),
          };
        },
      );
      setSelected(new Set());
    } catch {
      toast.error(t("duplicateDeleteFailed"));
    } finally {
      setDeleting(false);
    }
  }

  // ── Delete single ──

  async function handleDeleteSingle(id: number) {
    setDeleting(true);
    try {
      await ipc.client.photos.deletePhoto({ id });
      // Optimistic: remove affected pairs from query cache
      queryClient.setQueryData<{ duplicates: DuplicatePair[]; fromCache?: boolean }>(
        ["duplicates"],
        (prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            duplicates: prev.duplicates.filter(
              (p) => p.photoA.id !== id && p.photoB.id !== id
            ),
          };
        },
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

  // ── Stable callback refs for PairCard (avoids stale closures) ──

  const toggleSelectRef = useRef(toggleSelect);
  const handleDeleteSingleRef = useRef(handleDeleteSingle);
  const handleDismissRef = useRef(handleDismiss);
  useEffect(() => {
    toggleSelectRef.current = toggleSelect;
  }, [pairs, selected, strategy]); // re-stabilise when deps change
  useEffect(() => {
    handleDeleteSingleRef.current = handleDeleteSingle;
  }, [pairs, selected, deleting]);
  useEffect(() => {
    handleDismissRef.current = handleDismiss;
  }, [pairs]);

  const stableToggleSelect = useCallback(
    (id: number) => toggleSelectRef.current(id),
    [],
  );
  const stableDeleteSingle = useCallback(
    (id: number) => handleDeleteSingleRef.current(id),
    [],
  );
  const stableDismiss = useCallback(
    (pair: DuplicatePair) => handleDismissRef.current(pair),
    [],
  );

  // ── Loading state ──

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  // ── Render ──

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
            onClick={handleRescan}
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

      {/* Virtual-scrolled content */}
      <div ref={parentRef} className="flex-1 overflow-y-auto p-6">
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
          <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const row = allRows[virtualItem.index];
              return (
                <div
                  key={virtualItem.key}
                  data-index={virtualItem.index}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  {row.type === "header" ? (
                    <div className="flex items-center gap-2 pb-3">
                      <span
                        className={`rounded-[4px] px-2 py-0.5 font-[510] text-[11px] ${row.label.color}`}
                      >
                        {row.title}
                      </span>
                      <span className="text-[11px] text-muted-foreground/70">
                        {t("duplicateGroups", { count: row.count })}
                      </span>
                    </div>
                  ) : (
                    <PairCard
                      deleting={deleting}
                      key={row.pairKey}
                      onDelete={stableDeleteSingle}
                      onDismiss={() => stableDismiss(row.pair)}
                      onToggle={stableToggleSelect}
                      pair={row.pair}
                      selected={selected}
                      t={t}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/duplicates")({
  component: DuplicatesPage,
});
