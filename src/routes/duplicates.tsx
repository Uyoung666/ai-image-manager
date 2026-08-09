import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  Eye,
  Images,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import {
  memo,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { duplicateActions } from "@/actions/duplicates";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { MasonryBackToTop } from "@/components/MasonryBackToTop";
import {
  Tooltip as AppTooltip,
  TooltipContent as AppTooltipContent,
  TooltipTrigger as AppTooltipTrigger,
} from "@/components/ui/tooltip";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import type {
  DuplicateGroupPhotosResult,
  DuplicateGroupSummary,
  DuplicatePhoto,
} from "@/services/duplicate-groups";
import { toLocalMediaUrl } from "@/utils/local-media-url";

type GroupFilter = "all" | "exact" | "similar" | "dismissed";
interface DuplicatesResult {
  fromCache?: boolean;
  groups: DuplicateGroupSummary[];
}

const EMPTY_GROUPS: DuplicateGroupSummary[] = [];
const DUPLICATES_TOOLBAR_FALLBACK_HEIGHT = 48;
const DUPLICATES_TOOLBAR_CONTENT_GAP = 16;
const DUPLICATE_GROUP_PAGE_SIZE = 48;
const DUPLICATE_GROUP_VIRTUAL_THRESHOLD = 24;

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatResolution(photo: DuplicatePhoto): string {
  return photo.width && photo.height ? `${photo.width}×${photo.height}` : "—";
}

function estimateReclaimBytes(
  group: DuplicateGroupSummary,
  photos: DuplicatePhoto[],
  keeperId: number
): number {
  if (keeperId === group.recommendedKeepId) {
    return group.estimatedReclaimBytes;
  }
  const recommended = group.previewPhotos.find(
    (photo) => photo.id === group.recommendedKeepId
  );
  const keeper = photos.find((photo) => photo.id === keeperId);
  if (recommended?.fileSize == null || keeper?.fileSize == null) {
    return group.estimatedReclaimBytes;
  }
  return Math.max(
    0,
    group.estimatedReclaimBytes + recommended.fileSize - keeper.fileSize
  );
}

const DuplicatePhotoTile = memo(function DuplicatePhotoTile({
  isKeeper,
  pendingDelete,
  photo,
  onKeep,
  t,
}: {
  isKeeper: boolean;
  onKeep: () => void;
  pendingDelete: boolean;
  photo: DuplicatePhoto;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const [failed, setFailed] = useState(false);
  const src = photo.thumbnailPath || photo.path;
  let tileClass = "border-border bg-background hover:border-primary/40";
  let badgeClass =
    "bg-background/90 text-muted-foreground opacity-0 shadow-sm group-hover:opacity-100";
  let badgeText = t("duplicateSetKeeper");
  if (isKeeper) {
    tileClass = "border-success/60 bg-success/5 ring-1 ring-success/20";
    badgeClass = "bg-success text-white";
    badgeText = t("duplicateKeep");
  } else if (pendingDelete) {
    tileClass = "border-destructive/40 bg-destructive/5";
    badgeClass = "bg-destructive text-white";
    badgeText = t("pendingDelete");
  }
  return (
    <button
      className={`group relative min-w-0 overflow-hidden rounded-[8px] border text-left transition-colors ${tileClass}`}
      onClick={onKeep}
      type="button"
    >
      <div className="relative flex h-36 items-center justify-center bg-muted/30 p-2">
        {failed ? (
          <Images className="h-8 w-8 text-muted-foreground/30" />
        ) : (
          // biome-ignore lint/a11y/noNoninteractiveElementInteractions: onError only swaps in a visual fallback
          <img
            alt={photo.filename}
            className={`h-full w-full object-contain transition-opacity ${pendingDelete ? "opacity-60" : "opacity-100"}`}
            decoding="async"
            height={144}
            loading="lazy"
            onError={() => setFailed(true)}
            src={toLocalMediaUrl(src)}
            width={240}
          />
        )}
        <span
          className={`absolute top-2 right-2 flex items-center gap-1 rounded-full px-2 py-1 font-medium text-[10px] ${badgeClass}`}
        >
          {isKeeper ? <Check className="h-3 w-3" /> : null}
          {badgeText}
        </span>
      </div>
      <div className="border-border border-t p-2.5">
        <AppTooltip>
          <AppTooltipTrigger asChild>
            <p className="truncate text-[11px] text-foreground">
              {photo.filename}
            </p>
          </AppTooltipTrigger>
          <AppTooltipContent>{photo.filename}</AppTooltipContent>
        </AppTooltip>
        <p className="mt-1 flex gap-3 text-[10px] text-muted-foreground">
          <span>{formatFileSize(photo.fileSize ?? 0)}</span>
          <span>{formatResolution(photo)}</span>
        </p>
      </div>
    </button>
  );
});

const DuplicatePhotoGrid = memo(function DuplicatePhotoGrid({
  enabled,
  error,
  group,
  keeperId,
  loading,
  onLoadMore,
  onKeeperChange,
  photos,
  t,
}: {
  enabled: boolean;
  error: boolean;
  group: DuplicateGroupSummary;
  keeperId: number;
  loading: boolean;
  onKeeperChange: (photoId: number) => void;
  onLoadMore: () => void;
  photos: DuplicatePhoto[];
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [columnCount, setColumnCount] = useState(1);
  const shouldVirtualize = group.photoCount > DUPLICATE_GROUP_VIRTUAL_THRESHOLD;

  useLayoutEffect(() => {
    const element = gridRef.current;
    if (!element) {
      return;
    }
    const updateColumns = () => {
      const width = element.clientWidth;
      setColumnCount(Math.max(1, Math.floor((width + 10) / (180 + 10))));
    };
    updateColumns();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(updateColumns);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const rowCount = Math.ceil(photos.length / columnCount);
  const virtualizer = useVirtualizer({
    count: shouldVirtualize ? rowCount : 0,
    estimateSize: () => 216,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => `duplicate-row-${group.groupKey}-${index}`,
    overscan: 2,
  });

  useEffect(() => {
    if (
      !shouldVirtualize ||
      loading ||
      error ||
      photos.length >= group.photoCount ||
      !virtualizer.getVirtualItems().some((item) => item.index >= rowCount - 2)
    ) {
      return;
    }
    onLoadMore();
  }, [
    group.photoCount,
    error,
    loading,
    onLoadMore,
    photos.length,
    rowCount,
    shouldVirtualize,
    virtualizer,
  ]);

  if (!shouldVirtualize) {
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,180px),1fr))] gap-2.5 p-3.5">
        {photos.map((photo) => (
          <DuplicatePhotoTile
            isKeeper={photo.id === keeperId}
            key={photo.id}
            onKeep={() => onKeeperChange(photo.id)}
            pendingDelete={enabled && photo.id !== keeperId}
            photo={photo}
            t={t}
          />
        ))}
      </div>
    );
  }

  let detailFooter: ReactNode = null;
  if (loading) {
    detailFooter = (
      <div className="py-3 text-center text-[11px] text-muted-foreground">
        {t("loadingPhotos")}
      </div>
    );
  } else if (error) {
    detailFooter = (
      <button
        className="mx-auto mt-3 block rounded-[6px] border border-border px-3 py-1.5 text-[11px] text-muted-foreground hover:text-foreground"
        onClick={onLoadMore}
        type="button"
      >
        {t("duplicateDetailsRetry")}
      </button>
    );
  }

  return (
    <div
      className="max-h-[min(60dvh,720px)] overflow-y-auto p-3.5"
      ref={scrollRef}
    >
      <div
        className="relative w-full"
        ref={gridRef}
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualizer.getVirtualItems().map((row) => {
          const rowPhotos = photos.slice(
            row.index * columnCount,
            (row.index + 1) * columnCount
          );
          return (
            <div
              className="absolute top-0 left-0 grid w-full gap-2.5"
              data-index={row.index}
              key={row.key}
              ref={virtualizer.measureElement}
              style={{
                gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
                transform: `translateY(${row.start}px)`,
              }}
            >
              {rowPhotos.map((photo) => (
                <DuplicatePhotoTile
                  isKeeper={photo.id === keeperId}
                  key={photo.id}
                  onKeep={() => onKeeperChange(photo.id)}
                  pendingDelete={enabled && photo.id !== keeperId}
                  photo={photo}
                  t={t}
                />
              ))}
            </div>
          );
        })}
      </div>
      {detailFooter}
    </div>
  );
});

const DuplicateGroupCard = memo(function DuplicateGroupCard({
  enabled,
  group,
  detailError,
  loadingPhotos,
  keeperId,
  onDismiss,
  onLoadMore,
  onKeeperChange,
  onToggleEnabled,
  photos,
  t,
}: {
  enabled: boolean;
  group: DuplicateGroupSummary;
  detailError: boolean;
  loadingPhotos: boolean;
  keeperId: number;
  onDismiss: () => void;
  onLoadMore: () => void;
  onKeeperChange: (photoId: number) => void;
  onToggleEnabled: () => void;
  photos: DuplicatePhoto[];
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const dismissed = group.status === "dismissed";
  let toggleClass = "bg-muted text-muted-foreground hover:text-foreground";
  if (enabled) {
    toggleClass = "bg-destructive/10 text-destructive hover:bg-destructive/15";
  } else if (group.matchType === "similar") {
    toggleClass =
      "border border-warning/25 bg-warning/10 text-warning hover:bg-warning/15";
  }
  return (
    <article className="overflow-hidden rounded-[10px] border border-border bg-secondary/70 shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
      <header className="flex min-h-11 flex-wrap items-center justify-between gap-3 border-border border-b px-3.5 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span
            className={`rounded-[4px] px-2 py-0.5 font-medium text-[10px] ${
              group.matchType === "exact"
                ? "bg-destructive/10 text-destructive"
                : "bg-warning/10 text-warning"
            }`}
          >
            {t(
              group.matchType === "exact"
                ? "exactDuplicate"
                : "duplicateSimilarGroup"
            )}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {t("duplicatePhotoCount", { count: group.photoCount })}
          </span>
          {group.sequenceSummaries.map((sequence) => (
            <span
              className="rounded-full border border-border bg-background/60 px-2 py-0.5 text-[10px] text-muted-foreground"
              key={sequence.sequenceId}
            >
              {t("sequenceCardLabel", {
                count: sequence.memberCount,
                type: t(
                  sequence.type === "burst"
                    ? "sequenceBurst"
                    : "sequenceTimelapse"
                ),
              })}
            </span>
          ))}
          {group.matchType === "similar" && !dismissed ? (
            <AppTooltip>
              <AppTooltipTrigger asChild>
                <span className="flex items-center gap-1 rounded-full border border-warning/20 bg-warning/10 px-2 py-0.5 text-[10px] text-warning">
                  <Eye className="h-3 w-3" />
                  {t("duplicateManualReview")}
                </span>
              </AppTooltipTrigger>
              <AppTooltipContent>
                {t("duplicateSimilarManualHint")}
              </AppTooltipContent>
            </AppTooltip>
          ) : null}
          {!dismissed && enabled ? (
            <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] text-destructive">
              {t("duplicateWillCleanCount", { count: group.photoCount - 1 })}
            </span>
          ) : null}
        </div>
        <div className="flex max-w-full flex-wrap items-center gap-2">
          {dismissed ? null : (
            <button
              className={`rounded-[5px] px-2.5 py-1 text-[11px] transition-colors ${toggleClass}`}
              onClick={onToggleEnabled}
              type="button"
            >
              {enabled
                ? t("duplicateRemoveFromCleanup")
                : t("duplicateConfirmGroup")}
            </button>
          )}
          {dismissed ? (
            <span className="text-[11px] text-muted-foreground">
              {t("duplicateIgnored")}
            </span>
          ) : (
            <button
              className="text-[11px] text-muted-foreground hover:text-foreground"
              onClick={onDismiss}
              type="button"
            >
              {t("duplicateIgnoreGroup")}
            </button>
          )}
        </div>
      </header>
      <DuplicatePhotoGrid
        enabled={enabled}
        error={detailError}
        group={group}
        keeperId={keeperId}
        loading={loadingPhotos}
        onKeeperChange={onKeeperChange}
        onLoadMore={onLoadMore}
        photos={photos}
        t={t}
      />
    </article>
  );
});

export function DuplicatesPage() {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const parentRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<GroupFilter>("all");
  const [keeperByGroup, setKeeperByGroup] = useState<Record<string, number>>(
    {}
  );
  const [enabledGroups, setEnabledGroups] = useState<Set<string>>(new Set());
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const [isToolbarScrolled, setIsToolbarScrolled] = useState(false);
  const [showBackToTop, setShowBackToTop] = useState(false);
  const [photosByGroup, setPhotosByGroup] = useState<
    Record<string, DuplicatePhoto[]>
  >({});
  const [detailState, setDetailState] = useState<
    Record<
      string,
      { error: boolean; hasMore: boolean; loading: boolean; total: number }
    >
  >({});
  const loadingGroupKeysRef = useRef(new Set<string>());
  const [toolbarHeight, setToolbarHeight] = useState(
    DUPLICATES_TOOLBAR_FALLBACK_HEIGHT
  );

  useLayoutEffect(() => {
    const element = toolbarRef.current;
    if (!element) {
      return;
    }
    const updateHeight = () =>
      setToolbarHeight(
        element.offsetHeight || DUPLICATES_TOOLBAR_FALLBACK_HEIGHT
      );
    updateHeight();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const { data, isLoading } = useQuery({
    queryKey: ["duplicates"],
    queryFn: () => duplicateActions.scan(false) as Promise<DuplicatesResult>,
    staleTime: 30_000,
  });
  const groups = data?.groups ?? EMPTY_GROUPS;
  const activeGroups = groups.filter((group) => group.status === "active");

  useEffect(() => {
    const validKeys = new Set(groups.map((group) => group.groupKey));
    setPhotosByGroup((previous) => {
      const next: Record<string, DuplicatePhoto[]> = {};
      for (const group of groups) {
        const loaded = previous[group.groupKey];
        next[group.groupKey] = loaded?.length ? loaded : group.previewPhotos;
      }
      return next;
    });
    setDetailState((previous) => {
      const next: typeof previous = {};
      for (const group of groups) {
        const current = previous[group.groupKey];
        next[group.groupKey] = current ?? {
          error: false,
          hasMore: group.previewPhotos.length < group.photoCount,
          loading: false,
          total: group.photoCount,
        };
      }
      for (const key of Object.keys(next)) {
        if (!validKeys.has(key)) {
          delete next[key];
        }
      }
      return next;
    });
  }, [groups]);

  useEffect(() => {
    setKeeperByGroup((previous) => {
      const next = { ...previous };
      for (const group of groups) {
        if (!(group.groupKey in next)) {
          next[group.groupKey] = group.recommendedKeepId;
        }
      }
      return next;
    });
    setEnabledGroups((previous) => {
      const validKeys = new Set(groups.map((group) => group.groupKey));
      const next = new Set([...previous].filter((key) => validKeys.has(key)));
      for (const group of groups) {
        if (
          group.status === "active" &&
          group.matchType === "exact" &&
          !previous.has(group.groupKey)
        ) {
          next.add(group.groupKey);
        }
      }
      return next;
    });
  }, [groups]);

  const rescan = useMutation({
    mutationFn: () => duplicateActions.scan(true) as Promise<DuplicatesResult>,
    onSuccess: (result) => queryClient.setQueryData(["duplicates"], result),
    onError: () => toast.error(t("duplicateScanFailed")),
  });

  const dismiss = useMutation({
    mutationFn: (group: DuplicateGroupSummary) =>
      duplicateActions.dismissGroup(group.groupKey),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["duplicates"] }),
    onError: () => toast.error(t("duplicateIgnoreFailed")),
  });

  const loadGroupPhotos = async (groupKey: string): Promise<void> => {
    const currentState = detailState[groupKey];
    const currentPhotos = photosByGroup[groupKey] ?? [];
    if (
      loadingGroupKeysRef.current.has(groupKey) ||
      currentState?.loading ||
      currentState?.hasMore === false
    ) {
      return;
    }
    loadingGroupKeysRef.current.add(groupKey);
    setDetailState((previous) => ({
      ...previous,
      [groupKey]: {
        ...(previous[groupKey] ?? {
          error: false,
          hasMore: true,
          loading: false,
          total: currentPhotos.length,
        }),
        error: false,
        loading: true,
      },
    }));
    try {
      const result = (await duplicateActions.getGroupPhotos({
        groupKey,
        limit: DUPLICATE_GROUP_PAGE_SIZE,
        offset: currentPhotos.length,
      })) as DuplicateGroupPhotosResult;
      setPhotosByGroup((previous) => {
        const existing = previous[groupKey] ?? [];
        const ids = new Set(existing.map((photo) => photo.id));
        return {
          ...previous,
          [groupKey]: [
            ...existing,
            ...result.photos.filter((photo) => !ids.has(photo.id)),
          ],
        };
      });
      setDetailState((previous) => ({
        ...previous,
        [groupKey]: {
          error: false,
          hasMore: result.hasMore,
          loading: false,
          total: result.total,
        },
      }));
    } catch {
      setDetailState((previous) => ({
        ...previous,
        [groupKey]: {
          ...(previous[groupKey] ?? {
            hasMore: true,
            total: currentPhotos.length,
          }),
          error: true,
          loading: false,
        },
      }));
      toast.error(t("duplicateDetailsLoadFailed"));
    } finally {
      loadingGroupKeysRef.current.delete(groupKey);
    }
  };

  const cleanupGroups = activeGroups.filter((group) =>
    enabledGroups.has(group.groupKey)
  );
  const cleanupCount = cleanupGroups.reduce(
    (sum, group) => sum + group.photoCount - 1,
    0
  );
  const reclaimBytes = cleanupGroups.reduce(
    (sum, group) =>
      sum +
      estimateReclaimBytes(
        group,
        photosByGroup[group.groupKey] ?? group.previewPhotos,
        keeperByGroup[group.groupKey] ?? group.recommendedKeepId
      ),
    0
  );

  const cleanup = useMutation({
    mutationFn: () =>
      duplicateActions.cleanGroups(
        cleanupGroups.map((group) => ({
          groupKey: group.groupKey,
          keepPhotoId: keeperByGroup[group.groupKey] ?? group.recommendedKeepId,
        }))
      ),
    onSuccess: async (result) => {
      setConfirmCleanup(false);
      setEnabledGroups(new Set());
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["duplicates"] }),
        queryClient.invalidateQueries({ queryKey: ["photos"] }),
        queryClient.invalidateQueries({ queryKey: ["folders"] }),
      ]);
      toast.success(t("duplicateCleanupSuccess", { count: result.deleted }));
    },
    onError: () => {
      setConfirmCleanup(false);
      toast.error(t("duplicateDeleteFailed"));
    },
  });

  const filteredGroups = useMemo(() => {
    if (filter === "dismissed") {
      return groups.filter((group) => group.status === "dismissed");
    }
    return groups.filter(
      (group) =>
        group.status === "active" &&
        (filter === "all" || group.matchType === filter)
    );
  }, [filter, groups]);

  const virtualizer = useVirtualizer({
    count: filteredGroups.length,
    estimateSize: (index) =>
      230 +
      Math.ceil(
        Math.min(filteredGroups[index].photoCount, DUPLICATE_GROUP_PAGE_SIZE) /
          4
      ) *
        205,
    getScrollElement: () => parentRef.current,
    getItemKey: (index) => filteredGroups[index].groupKey,
    overscan: 3,
  });

  const involvedPhotos = activeGroups.reduce(
    (sum, group) => sum + group.photoCount,
    0
  );
  const filters: [GroupFilter, string, number][] = [
    ["all", t("duplicateFilterAll"), activeGroups.length],
    [
      "exact",
      t("exactDuplicate"),
      activeGroups.filter((group) => group.matchType === "exact").length,
    ],
    [
      "similar",
      t("duplicateSimilarGroup"),
      activeGroups.filter((group) => group.matchType === "similar").length,
    ],
    [
      "dismissed",
      t("duplicateIgnored"),
      groups.filter((group) => group.status === "dismissed").length,
    ],
  ];

  return (
    <div className="flex h-full min-w-0 flex-col bg-background">
      <header className="border-border border-b px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-3 lg:grid lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:gap-4">
          <div className="flex min-w-0 flex-1 items-center gap-3 lg:flex-initial">
            <button
              className="flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
              onClick={() => navigate({ to: "/" })}
              type="button"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
            <div className="min-w-0">
              <h1 className="font-semibold text-[20px] text-foreground tracking-tight">
                {t("duplicatesTitle")}
              </h1>
              {isLoading ? null : (
                <p className="mt-0.5 text-[12px] text-muted-foreground/70">
                  {t("duplicateSummary", {
                    groups: activeGroups.length,
                    photos: involvedPhotos,
                  })}
                </p>
              )}
            </div>
          </div>
          {!isLoading && activeGroups.length > 0 ? (
            <div className="order-3 flex w-full items-center divide-x divide-border overflow-x-auto rounded-[7px] border border-border bg-muted/35 lg:order-none lg:w-auto">
              {[
                [t("duplicateGroupStat"), activeGroups.length],
                [t("duplicatePhotoStat"), involvedPhotos],
                [t("duplicatePendingStat"), cleanupCount],
                [t("duplicateReclaimStat"), formatFileSize(reclaimBytes)],
              ].map(([label, value]) => (
                <div
                  className="flex shrink-0 items-baseline gap-1.5 px-3 py-1.5"
                  key={label}
                >
                  <p className="text-[10px] text-muted-foreground">{label}</p>
                  <p className="font-semibold text-[13px] text-foreground tabular-nums">
                    {value}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <div />
          )}
          <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2 lg:ml-0 lg:justify-self-end">
            <button
              className="flex items-center gap-1.5 rounded-[6px] border border-border px-3 py-1.5 font-medium text-[13px] text-foreground transition-colors hover:bg-foreground/5 disabled:opacity-40"
              disabled={rescan.isPending}
              onClick={() => rescan.mutate()}
              type="button"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${rescan.isPending ? "animate-spin" : ""}`}
              />
              {t("rescan")}
            </button>
            <button
              className="flex items-center gap-1.5 rounded-[6px] bg-destructive px-4 py-1.5 font-medium text-[13px] text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              disabled={cleanupCount === 0 || cleanup.isPending}
              onClick={() => setConfirmCleanup(true)}
              type="button"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t("duplicateCleanupButton", { count: cleanupCount })}
            </button>
          </div>
        </div>
      </header>

      <div className="relative flex min-h-0 min-w-0 flex-1">
        <nav
          className={`page-toolbar absolute top-0 right-0 left-0 z-50 flex flex-wrap items-center justify-between gap-2 overflow-x-hidden border-b px-4 py-1.5 sm:px-6 ${
            isToolbarScrolled ? "is-scrolled" : ""
          }`}
          ref={toolbarRef}
        >
          <div className="inline-flex max-w-full shrink-0 overflow-x-auto rounded-[8px] border border-border bg-secondary p-1">
            {filters.map(([key, label, count]) => (
              <button
                aria-pressed={filter === key}
                className={`rounded-[6px] px-3 py-1.5 text-[12px] transition-colors ${
                  filter === key
                    ? "bg-card font-medium text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                key={key}
                onClick={() => setFilter(key)}
                type="button"
              >
                {label}
                <span className="ml-1.5 text-[10px] text-muted-foreground">
                  {count}
                </span>
              </button>
            ))}
          </div>
          <span className="ml-auto flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5 text-success" />
            {t("duplicateSafetyHint")}
          </span>
        </nav>

        <main
          className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6"
          onScroll={(event) => {
            const isScrolled = event.currentTarget.scrollTop > 4;
            setIsToolbarScrolled(isScrolled);
            setShowBackToTop(isScrolled);
          }}
          ref={parentRef}
          style={{
            paddingTop:
              (toolbarHeight || DUPLICATES_TOOLBAR_FALLBACK_HEIGHT) +
              DUPLICATES_TOOLBAR_CONTENT_GAP,
          }}
        >
          {isLoading ? (
            <div className="space-y-4">
              {[0, 1, 2].map((item) => (
                <div
                  className="h-72 animate-pulse rounded-[10px] bg-muted"
                  key={item}
                />
              ))}
            </div>
          ) : null}
          {!isLoading && filteredGroups.length === 0 ? (
            <div className="flex h-full items-center justify-center text-center">
              <div>
                <CheckCircle2 className="mx-auto h-10 w-10 text-success/60" />
                <p className="mt-3 font-medium text-[16px]">
                  {t(
                    filter === "dismissed"
                      ? "duplicateNoIgnored"
                      : "noDuplicatesTitle"
                  )}
                </p>
                <p className="mt-2 text-[13px] text-muted-foreground">
                  {t("noDuplicatesDescription")}
                </p>
              </div>
            </div>
          ) : null}
          {!isLoading && filteredGroups.length > 0 ? (
            <div
              className="relative w-full"
              style={{ height: `${virtualizer.getTotalSize()}px` }}
            >
              {virtualizer.getVirtualItems().map((item) => {
                const group = filteredGroups[item.index];
                const loadedPhotos = photosByGroup[group.groupKey] ?? [];
                const currentDetailState = detailState[group.groupKey] ?? {
                  error: false,
                  hasMore: loadedPhotos.length < group.photoCount,
                  loading: false,
                  total: group.photoCount,
                };
                return (
                  <div
                    className="absolute top-0 left-0 w-full pb-4"
                    data-index={item.index}
                    key={item.key}
                    ref={virtualizer.measureElement}
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    <DuplicateGroupCard
                      detailError={currentDetailState.error}
                      enabled={enabledGroups.has(group.groupKey)}
                      group={group}
                      keeperId={
                        keeperByGroup[group.groupKey] ?? group.recommendedKeepId
                      }
                      loadingPhotos={currentDetailState.loading}
                      onDismiss={() => dismiss.mutate(group)}
                      onKeeperChange={(photoId) =>
                        setKeeperByGroup((previous) => ({
                          ...previous,
                          [group.groupKey]: photoId,
                        }))
                      }
                      onLoadMore={() => loadGroupPhotos(group.groupKey)}
                      onToggleEnabled={() =>
                        setEnabledGroups((previous) => {
                          const next = new Set(previous);
                          if (next.has(group.groupKey)) {
                            next.delete(group.groupKey);
                          } else {
                            next.add(group.groupKey);
                          }
                          return next;
                        })
                      }
                      photos={loadedPhotos}
                      t={t}
                    />
                  </div>
                );
              })}
            </div>
          ) : null}
        </main>
        <MasonryBackToTop
          label={t("backToTop")}
          onClick={(event) => {
            event.stopPropagation();
            const element = parentRef.current;
            if (!element) {
              return;
            }
            element.scrollTo({
              top: 0,
              behavior:
                reduceMotion || element.scrollTop > element.clientHeight * 4
                  ? "auto"
                  : "smooth",
            });
          }}
          selectionActive={false}
          show={showBackToTop}
        />
      </div>

      <ConfirmDialog
        confirmText={
          cleanup.isPending ? t("deleting") : t("duplicateConfirmCleanup")
        }
        description={t("duplicateCleanupDescription", {
          groups: cleanupGroups.length,
          count: cleanupCount,
          size: formatFileSize(reclaimBytes),
        })}
        destructive
        disabled={cleanup.isPending}
        onCancel={() => setConfirmCleanup(false)}
        onConfirm={() => cleanup.mutate()}
        open={confirmCleanup}
        title={t("duplicateCleanupTitle")}
      />
    </div>
  );
}

export const Route = createFileRoute("/duplicates")({
  component: DuplicatesPage,
});
