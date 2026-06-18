import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowLeft, CheckCircle2, RefreshCw, Trash2 } from "lucide-react";
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
import { ipc } from "@/ipc/manager";
import { toLocalMediaUrl } from "@/utils/local-media-url";

interface DupPhoto {
  createdAt: number;
  filename: string;
  fileSize: number | null;
  height: number | null;
  id: number;
  path: string;
  thumbnailPath: string | null;
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

type DuplicateRow =
  | {
      type: "header";
      key: string;
      title: string;
      label: { text: string; color: string };
      count: number;
    }
  | { type: "pair"; pair: DuplicatePair; pairKey: string };

type DuplicatesCache = { duplicates: DuplicatePair[]; fromCache?: boolean };

// ── Helpers ──────────────────────────────────────────────────────────

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
): { text: string; color: string } {
  switch (type) {
    case "exact":
      return {
        text: t("exactDuplicate"),
        color: "text-destructive bg-destructive/10",
      };
    case "clip_confirmed":
      return {
        text: t("visualDuplicate"),
        color: "text-warning bg-warning/10",
      };
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
  return a.createdAt <= b.createdAt ? b.id : a.id;
}

// ── PairImage — lazy-load thumbnail with fade-in + error fallback ───

const PairImage = memo(function PairImage({
  photo,
  t,
}: {
  photo: DupPhoto;
  t: (key: string) => string;
}) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [inView, setInView] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) {
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: "600px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const src = photo.thumbnailPath || photo.path;

  return (
    <div
      className="relative flex min-h-[220px] items-center justify-center bg-background p-4"
      ref={containerRef}
    >
      {inView && !error ? (
        <img
          alt={photo.filename}
          className={`max-h-[220px] rounded-[4px] object-contain transition-opacity duration-500 ${
            loaded ? "opacity-100" : "opacity-0"
          }`}
          decoding="async"
          loading="lazy"
          onError={() => setError(true)}
          onLoad={() => setLoaded(true)}
          src={toLocalMediaUrl(src)}
        />
      ) : error ? (
        <div className="flex flex-col items-center gap-2 text-muted-foreground/50">
          <span className="text-[32px]">🖼</span>
          <span className="text-[10px]">{t("imageLoadFailed")}</span>
        </div>
      ) : (
        <div className="h-[220px] w-full animate-pulse rounded-[4px] bg-muted" />
      )}
      {error && (
        <span className="absolute bottom-2 left-2 max-w-[90%] truncate text-[10px] text-muted-foreground/50">
          {photo.filename}
        </span>
      )}
    </div>
  );
});

// ── PairCard — memo'd for virtual scrolling stability ────────────────

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
            className={`rounded-[4px] px-1.5 py-0.5 font-medium text-[10px] ${label.color}`}
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
              <PairImage photo={photo} t={t} />
              {isSelected && (
                <div className="absolute top-2 right-2 rounded-full bg-destructive px-2 py-0.5 font-medium text-[10px] text-white">
                  {t("pendingDelete")}
                </div>
              )}
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
                        ? "bg-destructive/10 font-medium text-destructive"
                        : "text-muted-foreground hover:bg-muted"
                    }`}
                    onClick={() => onToggle(photo.id)}
                  >
                    {isSelected ? t("deselect") : t("selectDelete")}
                  </button>
                  <button
                    className="rounded-[4px] px-2 py-0.5 text-[10px] text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-40"
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

// ── Skeleton — placeholder while loading ────────────────────────────

function SkeletonPair() {
  return (
    <div className="overflow-hidden rounded-[8px] border border-border bg-secondary">
      <div className="flex items-center gap-3 border-border border-b px-4 py-2">
        <div className="h-5 w-16 animate-pulse rounded-[4px] bg-muted" />
        <div className="h-3 w-24 animate-pulse rounded-[4px] bg-muted" />
      </div>
      <div className="grid grid-cols-2">
        {[0, 1].map((i) => (
          <div
            className={`flex flex-col ${i === 0 ? "border-border border-r" : ""}`}
            key={i}
          >
            <div className="flex min-h-[220px] items-center justify-center bg-background p-4">
              <div className="h-[200px] w-full animate-pulse rounded-[4px] bg-muted" />
            </div>
            <div className="space-y-2 border-border border-t px-3 py-2">
              <div className="h-3 w-2/3 animate-pulse rounded-[3px] bg-muted" />
              <div className="h-3 w-1/3 animate-pulse rounded-[3px] bg-muted" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── DuplicatesPage ──────────────────────────────────────────────────

function DuplicatesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [strategy, setStrategy] = useState<RetentionStrategy>("manual");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [deleteSingleId, setDeleteSingleId] = useState<number | null>(null);
  const [pendingStrategy, setPendingStrategy] =
    useState<RetentionStrategy | null>(null);

  // ── Queries ──────────────────────────────────────────────────────

  const { data: pairsData, isLoading: loading } = useQuery({
    queryKey: ["duplicates"],
    queryFn: async () => {
      const result = await ipc.client.photos.findDuplicates({
        threshold: 8,
        forceRescan: false,
      });
      return result as DuplicatesCache;
    },
    staleTime: 30_000,
  });

  const pairs = pairsData?.duplicates || [];
  const deferredPairs = useDeferredValue(pairs);

  // ── Rescan mutation ─────────────────────────────────────────────

  const rescanMutation = useMutation({
    mutationFn: async () => {
      const result = await ipc.client.photos.findDuplicates({
        threshold: 8,
        forceRescan: true,
      });
      return result as DuplicatesCache;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["duplicates"], data);
    },
  });

  // ── Dismiss mutation (ignore pair) ──────────────────────────────

  const dismissMutation = useMutation({
    mutationFn: async (pair: DuplicatePair) => {
      if (pair.pairId) {
        await ipc.client.photos.dismissDuplicate({ pairId: pair.pairId });
      }
    },
    onMutate: async (pair) => {
      // Cancel outgoing refetches so they don't overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey: ["duplicates"] });
      const previous = queryClient.getQueryData<DuplicatesCache>([
        "duplicates",
      ]);
      queryClient.setQueryData<DuplicatesCache>(["duplicates"], (prev) => {
        if (!prev) {
          return prev;
        }
        return {
          ...prev,
          duplicates: prev.duplicates.filter(
            (p) =>
              !(
                p.photoA.id === pair.photoA.id && p.photoB.id === pair.photoB.id
              )
          ),
        };
      });
      // Return snapshot for rollback
      return { previous };
    },
    onError: (_err, _pair, context) => {
      // Rollback: restore previous state
      if (context?.previous) {
        queryClient.setQueryData(["duplicates"], context.previous);
      }
    },
  });

  // ── Batch delete mutation ───────────────────────────────────────

  const batchDeleteMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      await ipc.client.photos.deletePhotos({ ids });
    },
    onMutate: async (ids) => {
      await queryClient.cancelQueries({ queryKey: ["duplicates"] });
      const previous = queryClient.getQueryData<DuplicatesCache>([
        "duplicates",
      ]);
      const idSet = new Set(ids);
      queryClient.setQueryData<DuplicatesCache>(["duplicates"], (prev) => {
        if (!prev) {
          return prev;
        }
        return {
          ...prev,
          duplicates: prev.duplicates.filter(
            (p) => !(idSet.has(p.photoA.id) || idSet.has(p.photoB.id))
          ),
        };
      });
      return { previous };
    },
    onError: (_err, _ids, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["duplicates"], context.previous);
      }
      toast.error(t("duplicateDeleteFailed"));
    },
    onSettled: () => {
      setSelected(new Set());
    },
  });

  // ── Single delete mutation ──────────────────────────────────────

  const singleDeleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await ipc.client.photos.deletePhoto({ id });
    },
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ["duplicates"] });
      const previous = queryClient.getQueryData<DuplicatesCache>([
        "duplicates",
      ]);
      queryClient.setQueryData<DuplicatesCache>(["duplicates"], (prev) => {
        if (!prev) {
          return prev;
        }
        return {
          ...prev,
          duplicates: prev.duplicates.filter(
            (p) => p.photoA.id !== id && p.photoB.id !== id
          ),
        };
      });
      return { previous };
    },
    onError: (_err, _id, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["duplicates"], context.previous);
      }
      toast.error(t("duplicateDeleteFailed"));
    },
    onSettled: (_data, _err, id) => {
      setDeleteSingleId(null);
      setSelected((prev) => {
        const n = new Set(prev);
        n.delete(id);
        return n;
      });
    },
  });

  const deleting =
    batchDeleteMutation.isPending || singleDeleteMutation.isPending;

  // ── Grouped pairs → flattened rows for virtualizer ──────────────

  const grouped = useMemo(() => {
    const exact: DuplicatePair[] = [];
    const clipConfirmed: DuplicatePair[] = [];
    const phash: DuplicatePair[] = [];
    for (const p of deferredPairs) {
      if (p.matchType === "exact") {
        exact.push(p);
      } else if (p.matchType === "clip_confirmed") {
        clipConfirmed.push(p);
      } else {
        phash.push(p);
      }
    }
    return { exact, clipConfirmed, phash };
  }, [deferredPairs]);

  const allRows = useMemo((): DuplicateRow[] => {
    const rows: DuplicateRow[] = [];
    const sections = [
      ["exact", grouped.exact, t("exactDuplicate")],
      ["clip_confirmed", grouped.clipConfirmed, t("visualDuplicate")],
      ["phash", grouped.phash, t("highlySimilar")],
    ] as const;
    for (const [key, items, title] of sections) {
      if (items.length === 0) {
        continue;
      }
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

  // ── Virtualizer ─────────────────────────────────────────────────

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

  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;

  function pairKeyHash(key: string): number {
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
  }

  function rowStableId(row: DuplicateRow): number {
    return row.type === "pair"
      ? pairKeyHash(row.pairKey)
      : pairKeyHash(`h-${row.key}`);
  }

  useRouteScrollRestoration(parentRef, {
    getRouteKey: () => "duplicates",
    getCurrentAnchor: () => {
      const v = virtualizerRef.current;
      const items = v.getVirtualItems();
      if (items.length === 0) {
        return null;
      }
      const firstItem = items[0];
      const el = parentRef.current;
      if (!el) {
        return null;
      }
      const row = allRows[firstItem.index];
      if (!row) {
        return null;
      }
      return {
        itemId: rowStableId(row),
        offsetFromTop: firstItem.start - el.scrollTop,
      };
    },
    restoreFromAnchor: (anchorItemId: number) => {
      const currentIndex = allRows.findIndex(
        (row) => rowStableId(row) === anchorItemId
      );
      if (currentIndex === -1) {
        return null;
      }
      const v = virtualizerRef.current;
      const result = v.getOffsetForIndex(currentIndex);
      return result ? result[0] : null;
    },
    restoreReady: allRows.length > 0,
    itemCount: allRows.length,
  });

  // ── Selection & strategy ────────────────────────────────────────

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

  function confirmStrategyChange() {
    if (pendingStrategy) {
      setStrategy(pendingStrategy);
      setPendingStrategy(null);
    }
  }

  // ── Stable callback refs for virtualized PairCard ────────────────

  const toggleSelectRef = useRef(toggleSelect);
  const handleDismissRef = useRef((pair: DuplicatePair) =>
    dismissMutation.mutate(pair)
  );
  useEffect(() => {
    toggleSelectRef.current = toggleSelect;
  }, [pairs, selected, strategy]);
  useEffect(() => {
    handleDismissRef.current = (pair: DuplicatePair) =>
      dismissMutation.mutate(pair);
  }, [dismissMutation.mutate]);

  const stableToggleSelect = useCallback(
    (id: number) => toggleSelectRef.current(id),
    []
  );
  const stableDismiss = useCallback(
    (pair: DuplicatePair) => handleDismissRef.current(pair),
    []
  );
  const handleDeleteSingle = useCallback(
    (id: number) => setDeleteSingleId(id),
    []
  );

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
          <h1 className="font-semibold text-[18px] text-foreground">
            {t("duplicatesTitle")}
          </h1>
          {!loading && (
            <span className="text-[13px] text-muted-foreground/70">
              {t("duplicateGroups", { count: pairs.length })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button
            className="flex items-center gap-1.5 rounded-[6px] border border-input px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
            disabled={rescanMutation.isPending}
            onClick={() => rescanMutation.mutate()}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${rescanMutation.isPending ? "animate-spin" : ""}`}
            />
            {t("rescan")}
          </button>
          {selected.size > 0 && (
            <button
              className="flex items-center gap-1.5 rounded-[6px] border border-input px-3 py-1.5 text-[12px] text-destructive transition-colors hover:border-destructive/30 hover:bg-destructive/5 disabled:opacity-40"
              disabled={deleting}
              onClick={() => batchDeleteMutation.mutate(Array.from(selected))}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {deleting
                ? t("deleting")
                : t("deleteSelectedCount", { count: selected.size })}
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
                  ? "bg-primary/10 font-medium text-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              key={key}
              onClick={() => {
                if (key === "manual") {
                  setStrategy(key);
                  return;
                }
                let autoCount = 0;
                for (const pair of pairs) {
                  if (pickDeletion(pair, key)) {
                    autoCount++;
                  }
                }
                if (autoCount > 0) {
                  setPendingStrategy(key);
                } else {
                  setStrategy(key);
                }
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Content area */}
      <div className="flex-1 overflow-y-auto p-6" ref={parentRef}>
        {/* Skeleton screen */}
        {loading && (
          <div className="space-y-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <SkeletonPair key={`skel-${i}`} />
            ))}
          </div>
        )}

        {/* Empty state */}
        {!loading && pairs.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <CheckCircle2 className="mx-auto h-10 w-10 text-success/60" />
              <p className="mt-3 font-medium text-[16px] text-foreground">
                {t("noDuplicatesTitle")}
              </p>
              <p className="mt-2 text-[13px] text-muted-foreground/70">
                {t("noDuplicatesDescription")}
              </p>
            </div>
          </div>
        )}

        {/* Virtual-scrolled pairs */}
        {!loading && pairs.length > 0 && (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const row = allRows[virtualItem.index];
              return (
                <div
                  data-index={virtualItem.index}
                  key={virtualItem.key}
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
                        className={`rounded-[4px] px-2 py-0.5 font-medium text-[11px] ${row.label.color}`}
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
                      onDelete={handleDeleteSingle}
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

      <ConfirmDeleteDialog
        count={1}
        onCancel={() => setDeleteSingleId(null)}
        onConfirm={() => {
          if (deleteSingleId !== null) {
            singleDeleteMutation.mutate(deleteSingleId);
          }
        }}
        open={deleteSingleId !== null}
      />

      <ConfirmDialog
        confirmText={t("confirm")}
        description={t("strategyAutoSelectDesc", {
          count: pendingStrategy
            ? pairs.reduce((acc, pair) => {
                const toDelete = pickDeletion(pair, pendingStrategy);
                return toDelete ? acc + 1 : acc;
              }, 0)
            : 0,
        })}
        onCancel={() => setPendingStrategy(null)}
        onConfirm={confirmStrategyChange}
        open={pendingStrategy !== null}
        title={t("strategyAutoSelectTitle")}
      />
    </div>
  );
}

export const Route = createFileRoute("/duplicates")({
  component: DuplicatesPage,
});
