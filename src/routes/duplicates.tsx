import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertTriangle,
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
import { DuplicateCleanupBatches } from "@/components/duplicate-cleanup-batches";
import { FilterDropdown } from "@/components/filter-dropdown";
import { MasonryBackToTop } from "@/components/MasonryBackToTop";
import { type LightboxPhoto, PhotoLightbox } from "@/components/PhotoLightbox";
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
  DuplicatePhotoDecision,
} from "@/services/duplicate-groups";
import type { DuplicateReviewState } from "@/services/duplicate-review";
import { duplicateErrorKey } from "@/utils/duplicate-errors";
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
const INTEGER_INPUT_PATTERN = /^\d+$/;
const DECISION_LABELS = {
  KEEP: "duplicateDecisionKeep",
  DELETE: "duplicateDecisionDelete",
  UNDECIDED: "duplicateDecisionUndecided",
} as const;

function useDuplicatesQuery() {
  const query = useQuery({
    queryKey: ["duplicates"],
    queryFn: () => duplicateActions.scan(false) as Promise<DuplicatesResult>,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const initialQueryFailed = query.isError && !query.data;
  return {
    ...query,
    initialQueryFailed,
    queryReady: !(query.isLoading || initialQueryFailed),
  };
}

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

function toLightboxPhoto(photo: DuplicatePhoto): LightboxPhoto {
  return {
    fileDate: photo.fileDate,
    filename: photo.filename,
    fileSize: photo.fileSize ?? 0,
    height: photo.height ?? 0,
    id: photo.id,
    path: photo.path,
    thumbnailPath: photo.thumbnailPath,
    width: photo.width ?? 0,
  };
}

interface DuplicateDecisionSummary {
  complete: boolean;
  deletePhotoIds: number[];
  keepPhotoIds: number[];
  undecidedCount: number;
}

type DuplicateCleanupPlanResult = Awaited<
  ReturnType<typeof duplicateActions.createCleanupPlan>
>;

function getDuplicateDecisionSummary(
  group: DuplicateGroupSummary,
  decisions: Record<number, DuplicatePhotoDecision>
): DuplicateDecisionSummary {
  const keepPhotoIds: number[] = [];
  const deletePhotoIds: number[] = [];
  for (const [id, decision] of Object.entries(decisions)) {
    if (decision === "KEEP") {
      keepPhotoIds.push(Number(id));
    }
    if (decision === "DELETE") {
      deletePhotoIds.push(Number(id));
    }
  }
  const undecidedCount = Math.max(
    0,
    group.photoCount - keepPhotoIds.length - deletePhotoIds.length
  );
  return {
    complete: undecidedCount === 0 && keepPhotoIds.length > 0,
    keepPhotoIds,
    deletePhotoIds,
    undecidedCount,
  };
}

const DuplicatePhotoTile = memo(function DuplicatePhotoTile({
  decision,
  busy,
  needsReview,
  recommended,
  photo,
  onDecisionChange,
  onPreview,
  t,
}: {
  decision: DuplicatePhotoDecision;
  onDecisionChange: (decision: DuplicatePhotoDecision) => void;
  busy: boolean;
  needsReview: boolean;
  onPreview: () => void;
  photo: DuplicatePhoto;
  recommended: boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const [failed, setFailed] = useState(false);
  const src = photo.thumbnailPath || photo.path;
  let decisionLabel = t("duplicateDecisionUndecided");
  if (decision === "KEEP") {
    decisionLabel = t("duplicateDecisionKeep");
  } else if (decision === "DELETE") {
    decisionLabel = t("duplicateDecisionDelete");
  }
  let tileClass = "border-border bg-background hover:border-primary/40";
  let badgeClass = "bg-background/90 text-muted-foreground shadow-sm";
  if (decision === "KEEP") {
    tileClass = "border-success/60 bg-success/5 ring-1 ring-success/20";
    badgeClass = "bg-success text-white";
  } else if (decision === "DELETE") {
    tileClass = "border-destructive/40 bg-destructive/5";
    badgeClass = "bg-destructive text-white";
  }
  return (
    <div
      className={`group relative min-w-0 overflow-hidden rounded-[8px] border transition-colors ${tileClass}`}
    >
      <button
        aria-label={`${photo.filename} ${t("duplicatePreviewPhoto")}`}
        className="block w-full text-left"
        draggable={false}
        onClick={onPreview}
        type="button"
      >
        <div className="relative flex h-36 items-center justify-center bg-muted/30 p-2">
          {failed ? (
            <Images className="h-8 w-8 text-muted-foreground/30" />
          ) : (
            // biome-ignore lint/a11y/noNoninteractiveElementInteractions: onError only swaps in a visual fallback
            <img
              alt={photo.filename}
              className={`h-full w-full object-contain transition-opacity ${decision === "DELETE" ? "opacity-60" : "opacity-100"}`}
              decoding="async"
              draggable={false}
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
            {decision === "KEEP" ? <Check className="h-3 w-3" /> : null}
            {decisionLabel}
          </span>
          {recommended ? (
            <span className="absolute top-2 left-10 rounded-full bg-primary/90 px-2 py-1 font-medium text-[10px] text-white">
              {t("duplicateRecommended")}
            </span>
          ) : null}
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
      <fieldset
        aria-label={photo.filename}
        className="flex flex-wrap gap-1 border-border border-t p-2"
      >
        {(["KEEP", "DELETE", "UNDECIDED"] as const).map((value) => (
          <button
            aria-label={`${photo.filename} ${t(DECISION_LABELS[value])}`}
            aria-pressed={decision === value}
            className="rounded border border-border px-2 py-1 text-[11px] aria-pressed:bg-primary/15"
            disabled={busy}
            key={value}
            onClick={() => onDecisionChange(value)}
            type="button"
          >
            {t(DECISION_LABELS[value])}
          </button>
        ))}
        {busy ? (
          <span className="sr-only" role="status">
            {t("duplicateSavingReview")}
          </span>
        ) : null}
        {needsReview ? (
          <span className="text-warning">{t("duplicateNeedsReview")}</span>
        ) : null}
      </fieldset>
      <AppTooltip>
        <AppTooltipTrigger asChild>
          <button
            aria-label={t("duplicatePreviewPhoto")}
            className="absolute top-2 left-2 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-background/85 text-muted-foreground shadow-sm backdrop-blur-sm transition-[opacity,color,background-color] hover:bg-background hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary group-hover:opacity-100"
            onClick={(event) => {
              event.stopPropagation();
              onPreview();
            }}
            type="button"
          >
            <Eye className="h-3.5 w-3.5" />
          </button>
        </AppTooltipTrigger>
        <AppTooltipContent>{t("duplicatePreviewPhoto")}</AppTooltipContent>
      </AppTooltip>
    </div>
  );
});

const DuplicatePhotoGrid = memo(function DuplicatePhotoGrid({
  decisions,
  busy,
  error,
  group,
  loading,
  onLoadMore,
  onDecisionChange,
  onPreview,
  photos,
  t,
}: {
  decisions: Record<number, DuplicatePhotoDecision>;
  busy: boolean;
  error: boolean;
  group: DuplicateGroupSummary;
  loading: boolean;
  onDecisionChange: (photoId: number, decision: DuplicatePhotoDecision) => void;
  onLoadMore: () => void;
  onPreview: (photoId: number) => void;
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
    estimateSize: () => 260,
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
            busy={busy}
            decision={decisions[photo.id] ?? "UNDECIDED"}
            key={photo.id}
            needsReview={group.reviewPhotoIds?.includes(photo.id) ?? false}
            onDecisionChange={(decision) =>
              onDecisionChange(photo.id, decision)
            }
            onPreview={() => onPreview(photo.id)}
            photo={photo}
            recommended={photo.id === group.recommendedKeepId}
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
                  busy={busy}
                  decision={decisions[photo.id] ?? "UNDECIDED"}
                  key={photo.id}
                  needsReview={
                    group.reviewPhotoIds?.includes(photo.id) ?? false
                  }
                  onDecisionChange={(decision) =>
                    onDecisionChange(photo.id, decision)
                  }
                  onPreview={() => onPreview(photo.id)}
                  photo={photo}
                  recommended={photo.id === group.recommendedKeepId}
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
  decisions,
  busy,
  decisionSummary,
  enabled,
  group,
  detailError,
  loadingPhotos,
  onDismiss,
  onApplyKeepCount,
  onDecisionChange,
  onLoadMore,
  onPreview,
  onToggleEnabled,
  photos,
  t,
}: {
  decisions: Record<number, DuplicatePhotoDecision>;
  busy: boolean;
  decisionSummary: DuplicateDecisionSummary;
  enabled: boolean;
  group: DuplicateGroupSummary;
  detailError: boolean;
  loadingPhotos: boolean;
  onDismiss: () => void;
  onApplyKeepCount: (count: number) => void;
  onDecisionChange: (photoId: number, decision: DuplicatePhotoDecision) => void;
  onLoadMore: () => void;
  onPreview: (photoId: number) => void;
  onToggleEnabled: () => void;
  photos: DuplicatePhoto[];
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const [keepCountValue, setKeepCountValue] = useState("");
  const dismissed = group.status === "dismissed";
  const keepCountOptions = useMemo(
    () =>
      [...new Set([1, 2, 3, group.photoCount])]
        .filter((count) => count >= 1 && count <= group.photoCount)
        .sort((left, right) => left - right)
        .map((count) => ({
          label:
            count === group.photoCount
              ? t("duplicateKeepAll")
              : t("duplicateKeepCountOption", { count }),
          value: String(count),
        })),
    [group.photoCount, t]
  );
  const normalizedKeepCount = keepCountValue.trim();
  const parsedKeepCount = Number.parseInt(normalizedKeepCount, 10);
  const keepCountIsValid =
    INTEGER_INPUT_PATTERN.test(normalizedKeepCount) &&
    Number.isSafeInteger(parsedKeepCount) &&
    parsedKeepCount >= 1 &&
    parsedKeepCount <= group.photoCount;
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
          {dismissed ? null : (
            <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] text-destructive">
              {t("duplicateDecisionSummary", {
                deleteCount: decisionSummary.deletePhotoIds.length,
                keepCount: decisionSummary.keepPhotoIds.length,
                undecidedCount: decisionSummary.undecidedCount,
              })}
            </span>
          )}
        </div>
        <div className="flex max-w-full flex-wrap items-center gap-2">
          {dismissed ? null : (
            <div className="flex max-w-full flex-wrap items-center gap-2">
              <FilterDropdown
                ariaLabel={t("duplicateApplyKeepCount")}
                className="h-7 w-[8rem] text-[11px] disabled:opacity-100"
                disabled={busy}
                editable
                onChange={setKeepCountValue}
                options={keepCountOptions}
                placeholder={t("duplicateApplyKeepCount")}
                value={keepCountValue}
              />
              <button
                className="rounded-[5px] border border-border px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed"
                disabled={busy || !keepCountIsValid}
                onClick={() => {
                  onApplyKeepCount(parsedKeepCount);
                  setKeepCountValue("");
                }}
                type="button"
              >
                {t("duplicateKeepCountConfirm")}
              </button>
              <button
                className={`rounded-[5px] px-2.5 py-1 text-[11px] transition-colors ${toggleClass} disabled:cursor-not-allowed`}
                disabled={busy || !(decisionSummary.complete || enabled)}
                onClick={onToggleEnabled}
                type="button"
              >
                {enabled
                  ? t("duplicateRemoveFromCleanup")
                  : t("duplicateConfirmGroup")}
              </button>
            </div>
          )}
          {dismissed ? (
            <button
              className="text-[11px] text-muted-foreground hover:text-foreground"
              disabled={busy}
              onClick={onDismiss}
              type="button"
            >
              {t("duplicateUnignoreGroup")}
            </button>
          ) : (
            <button
              className="text-[11px] text-muted-foreground hover:text-foreground"
              disabled={busy}
              onClick={onDismiss}
              type="button"
            >
              {t("duplicateIgnoreGroup")}
            </button>
          )}
        </div>
      </header>
      <DuplicatePhotoGrid
        busy={busy || dismissed}
        decisions={decisions}
        error={detailError}
        group={group}
        loading={loadingPhotos}
        onDecisionChange={onDecisionChange}
        onLoadMore={onLoadMore}
        onPreview={onPreview}
        photos={photos}
        t={t}
      />
    </article>
  );
});

function DuplicateQueryError({
  onRetry,
  retrying,
  visible,
}: {
  onRetry: () => void;
  retrying: boolean;
  visible: boolean;
}) {
  const { t } = useTranslation();
  if (!visible) {
    return null;
  }
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground/70"
      role="alert"
    >
      <AlertTriangle
        aria-hidden="true"
        className="h-10 w-10 text-destructive/60"
      />
      <p className="text-[13px]">{t("duplicateScanFailed")}</p>
      <button
        className="mt-1 rounded-[6px] bg-primary px-4 py-1.5 font-medium text-[13px] text-white transition-opacity hover:opacity-90"
        disabled={retrying}
        onClick={onRetry}
        type="button"
      >
        {retrying ? t("loading") : t("retry")}
      </button>
    </div>
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Duplicate review coordinates scan, persisted decisions, immutable plans, and responsive confirmation state.
export function DuplicatesPage() {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const parentRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<GroupFilter>("all");
  const [enabledGroups, setEnabledGroups] = useState<
    Record<string, number | undefined>
  >({});
  const savingGroupKeys = useRef(new Set<string>());
  const [savingGroups, setSavingGroups] = useState<Record<string, boolean>>({});
  const [cleanupPlan, setCleanupPlan] =
    useState<DuplicateCleanupPlanResult | null>(null);
  const [cleanupDialogOpen, setCleanupDialogOpen] = useState(false);
  const [keepCountRequest, setKeepCountRequest] = useState<{
    count: number;
    group: DuplicateGroupSummary;
  } | null>(null);
  const [previewState, setPreviewState] = useState<{
    groupKey: string;
    photoId: number;
  } | null>(null);
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

  const {
    data,
    initialQueryFailed,
    isFetching,
    isLoading,
    queryReady,
    refetch,
  } = useDuplicatesQuery();
  const groups = data?.groups ?? EMPTY_GROUPS;
  const decisionsByGroup = useMemo(
    () =>
      Object.fromEntries(
        groups.map((group) => [group.groupKey, group.reviewDecisions ?? {}])
      ),
    [groups]
  );
  const activeGroups = groups.filter((group) => group.status === "active");
  const previewPhotos = useMemo(() => {
    if (!previewState) {
      return [];
    }
    return (photosByGroup[previewState.groupKey] ?? []).map(toLightboxPhoto);
  }, [photosByGroup, previewState]);
  const previewIndex = previewState
    ? previewPhotos.findIndex((photo) => photo.id === previewState.photoId)
    : -1;

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

  const applySavedReview = (review: DuplicateReviewState) => {
    queryClient.setQueryData<DuplicatesResult>(
      ["duplicates"],
      (previous) =>
        previous && {
          ...previous,
          groups: previous.groups.map((group) =>
            group.groupKey === review.groupKey
              ? {
                  ...group,
                  groupVersion: review.groupVersion,
                  reviewRevision: review.reviewRevision,
                  reviewComplete: review.complete,
                  reviewNeedsReview: review.needsReview,
                  reviewDecisions: Object.fromEntries(
                    review.members.map((member) => [
                      member.photoId,
                      member.decision,
                    ])
                  ),
                  reviewPhotoIds: review.members
                    .filter(
                      (member) =>
                        member.needsReview && member.decision !== "UNDECIDED"
                    )
                    .map((member) => member.photoId),
                }
              : group
          ),
        }
    );
  };

  const saveDecisions = async (
    group: DuplicateGroupSummary,
    decisions: Array<{ photoId: number; decision: DuplicatePhotoDecision }>,
    confirm = false
  ) => {
    if (
      savingGroupKeys.current.has(group.groupKey) ||
      !group.groupVersion ||
      group.reviewRevision === undefined
    ) {
      return;
    }
    savingGroupKeys.current.add(group.groupKey);
    setSavingGroups((previous) => ({ ...previous, [group.groupKey]: true }));
    setEnabledGroups((previous) => ({
      ...previous,
      [group.groupKey]: undefined,
    }));
    try {
      await queryClient.cancelQueries({ queryKey: ["duplicates"] });
      const result = await duplicateActions.updateReview({
        groupKey: group.groupKey,
        groupVersion: group.groupVersion,
        expectedReviewRevision: group.reviewRevision,
        decisions,
      });
      applySavedReview(result);
      if (confirm && result.complete) {
        setEnabledGroups((previous) => ({
          ...previous,
          [group.groupKey]: result.reviewRevision,
        }));
      }
    } catch (error) {
      toast.error(t(duplicateErrorKey(error, "duplicateReviewSaveFailed")));
      queryClient.invalidateQueries({ queryKey: ["duplicates"] });
    } finally {
      savingGroupKeys.current.delete(group.groupKey);
      setSavingGroups((previous) => ({ ...previous, [group.groupKey]: false }));
    }
  };

  const rescan = useMutation({
    mutationFn: () => duplicateActions.scan(true) as Promise<DuplicatesResult>,
    onSuccess: (result) => {
      setEnabledGroups({});
      queryClient.setQueryData(["duplicates"], result);
    },
    onError: (error) =>
      toast.error(t(duplicateErrorKey(error, "duplicateScanFailed"))),
  });

  const dismiss = useMutation({
    mutationFn: (group: DuplicateGroupSummary) =>
      duplicateActions.dismissGroup(
        group.groupKey,
        group.status !== "dismissed"
      ),
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

  const decisionSummaries = useMemo(() => {
    const summaries: Record<string, DuplicateDecisionSummary> = {};
    for (const group of activeGroups) {
      summaries[group.groupKey] = getDuplicateDecisionSummary(
        group,
        decisionsByGroup[group.groupKey] ?? {}
      );
    }
    return summaries;
  }, [activeGroups, decisionsByGroup]);
  const selectedGroups = activeGroups.filter(
    (group) =>
      enabledGroups[group.groupKey] !== undefined &&
      enabledGroups[group.groupKey] === group.reviewRevision &&
      !savingGroups[group.groupKey]
  );
  const cleanupGroups = selectedGroups.filter((group) => {
    const summary = decisionSummaries[group.groupKey];
    return Boolean(
      summary?.complete &&
        summary.keepPhotoIds.length > 0 &&
        summary.deletePhotoIds.length > 0 &&
        !group.reviewNeedsReview
    );
  });
  const cleanupCount = cleanupGroups.reduce(
    (sum, group) =>
      sum + (decisionSummaries[group.groupKey]?.deletePhotoIds.length ?? 0),
    0
  );
  const cleanupOutsideFilterCount = cleanupGroups
    .filter((group) => filter !== "all" && group.matchType !== filter)
    .reduce(
      (sum, group) =>
        sum + (decisionSummaries[group.groupKey]?.deletePhotoIds.length ?? 0),
      0
    );
  const reclaimBytes = cleanupGroups.reduce((sum, group) => {
    const summary = decisionSummaries[group.groupKey];
    if (!summary) {
      return sum;
    }
    return (
      sum +
      summary.deletePhotoIds.reduce(
        (photoSum, photoId) =>
          photoSum + (group.fileSizeByPhotoId?.[photoId] ?? 0),
        0
      )
    );
  }, 0);

  const createCleanupPlan = useMutation({
    mutationFn: () => {
      const groups = cleanupGroups.map((group) => {
        const summary = decisionSummaries[group.groupKey];
        if (
          !summary ||
          group.groupVersion === undefined ||
          group.reviewRevision === undefined
        ) {
          throw new Error("Duplicate group review is stale; rescan first");
        }
        return {
          deletePhotoIds: summary.deletePhotoIds,
          groupKey: group.groupKey,
          groupVersion: group.groupVersion,
          keepPhotoIds: summary.keepPhotoIds,
          matchType: group.matchType,
          reviewRevision: group.reviewRevision,
        };
      });
      return duplicateActions.createCleanupPlan({ groups });
    },
    onError: (error) => {
      toast.error(t(duplicateErrorKey(error, "duplicateCleanupPlanFailed")));
    },
    onSuccess: (plan) => {
      setCleanupPlan(plan);
      setCleanupDialogOpen(true);
    },
  });

  const executeCleanupPlan = useMutation({
    mutationFn: (planId: string) => duplicateActions.executeCleanupPlan(planId),
    onError: (error) => {
      toast.error(t(duplicateErrorKey(error, "duplicateCleanupExecuteFailed")));
      setCleanupPlan(null);
      setCleanupDialogOpen(false);
      queryClient.invalidateQueries({ queryKey: ["duplicates"] });
    },
    onSuccess: (result) => {
      setCleanupPlan(null);
      setCleanupDialogOpen(false);
      setEnabledGroups({});
      queryClient.invalidateQueries({
        queryKey: ["duplicate-cleanup-batches"],
      });
      queryClient.invalidateQueries({ queryKey: ["duplicates"] });
      toast.success(
        t("duplicateCleanupSuccess", { count: result.deletedCount })
      );
    },
  });

  const applyKeepCount = useMutation({
    mutationFn: ({
      count,
      group,
    }: {
      count: number;
      group: DuplicateGroupSummary;
    }) => {
      if (
        group.groupVersion === undefined ||
        group.reviewRevision === undefined
      ) {
        throw new Error("Duplicate group review is stale; rescan first");
      }
      return duplicateActions.applyKeepCount({
        count,
        expectedReviewRevision: group.reviewRevision,
        groupKey: group.groupKey,
        groupVersion: group.groupVersion,
      });
    },
    onError: () => toast.error(t("duplicateReviewSaveFailed")),
    onSuccess: (result, variables) => {
      applySavedReview(result);
      setKeepCountRequest(null);
      setEnabledGroups((previous) => ({
        ...previous,
        [variables.group.groupKey]: undefined,
      }));
    },
  });

  const requestApplyKeepCount = (
    group: DuplicateGroupSummary,
    count: number
  ) => {
    const summary = decisionSummaries[group.groupKey];
    if (
      summary &&
      (summary.keepPhotoIds.length > 0 || summary.deletePhotoIds.length > 0)
    ) {
      setKeepCountRequest({ count, group });
      return;
    }
    applyKeepCount.mutate({ count, group });
  };

  const scanBusy = isFetching || rescan.isPending;
  const [showScanProgress, setShowScanProgress] = useState(false);
  useEffect(() => {
    if (!scanBusy) {
      setShowScanProgress(false);
      return;
    }
    const timer = setTimeout(() => setShowScanProgress(true), 300);
    return () => clearTimeout(timer);
  }, [scanBusy]);
  const reviewBusy =
    Object.values(savingGroups).some(Boolean) || applyKeepCount.isPending;
  const progress = useQuery({
    queryKey: ["duplicate-scan-progress"],
    queryFn: duplicateActions.getScanProgress,
    enabled: scanBusy,
    refetchInterval: scanBusy ? 500 : false,
  });
  const cancelScan = useMutation({ mutationFn: duplicateActions.cancelScan });

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
    <div
      className="relative flex h-full min-w-0 flex-col bg-background"
      data-surface="page"
    >
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
              {queryReady ? (
                <p className="mt-0.5 text-[12px] text-muted-foreground/70">
                  {t("duplicateSummary", {
                    groups: activeGroups.length,
                    photos: involvedPhotos,
                  })}
                </p>
              ) : null}
            </div>
          </div>
          {queryReady && activeGroups.length > 0 ? (
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
            <DuplicateCleanupBatches />
            <button
              className="flex items-center gap-1.5 rounded-[6px] border border-border px-3 py-1.5 font-medium text-[13px] text-foreground transition-colors hover:bg-foreground/5"
              disabled={scanBusy || reviewBusy}
              onClick={() => rescan.mutate()}
              type="button"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${rescan.isPending ? "animate-spin" : ""}`}
              />
              {t("rescan")}
            </button>

            <button
              className="flex items-center gap-1.5 rounded-[6px] bg-destructive px-4 py-1.5 font-medium text-[13px] text-white transition-opacity hover:opacity-90 data-[unavailable=true]:opacity-40"
              data-unavailable={cleanupGroups.length === 0}
              disabled={
                cleanupGroups.length === 0 ||
                createCleanupPlan.isPending ||
                executeCleanupPlan.isPending ||
                scanBusy ||
                reviewBusy
              }
              onClick={() => createCleanupPlan.mutate()}
              type="button"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t("duplicateCleanupButton", { count: cleanupCount })}
            </button>
            {cleanupOutsideFilterCount > 0 ? (
              <div className="flex max-w-[14rem] flex-wrap items-center justify-end gap-x-2 gap-y-0.5 text-right text-[10px] text-muted-foreground">
                <span className="[overflow-wrap:anywhere]">
                  {t("duplicateCleanupOutsideFilter", {
                    count: cleanupOutsideFilterCount,
                  })}
                </span>
                <button
                  className="text-primary underline-offset-2 hover:underline"
                  onClick={() => setFilter("all")}
                  type="button"
                >
                  {t("duplicateViewAllPending")}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {scanBusy && showScanProgress ? (
        <div
          className="absolute right-4 bottom-4 left-4 z-50 flex max-w-full flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-background/95 px-4 py-2 text-xs shadow-sm"
          role="status"
        >
          <span>
            {t("duplicateScanProgress", {
              stage: t(
                `duplicateScanStage_${progress.data?.stage ?? "queued"}`
              ),
              count: progress.data?.processed ?? 0,
              total: progress.data?.total ?? 0,
            })}
          </span>
          <button
            className="rounded border border-border px-3 py-1"
            disabled={cancelScan.isPending}
            onClick={() => cancelScan.mutate()}
            type="button"
          >
            {t("cancel")}
          </button>
        </div>
      ) : null}

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
          <DuplicateQueryError
            onRetry={() => {
              refetch();
            }}
            retrying={isFetching}
            visible={initialQueryFailed}
          />
          {queryReady && filteredGroups.length === 0 ? (
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
          {queryReady && filteredGroups.length > 0 ? (
            <div
              className="relative w-full"
              style={{ height: `${virtualizer.getTotalSize()}px` }}
            >
              {virtualizer.getVirtualItems().map((item) => {
                const group = filteredGroups[item.index];
                const loadedPhotos =
                  photosByGroup[group.groupKey] ?? group.previewPhotos;
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
                      busy={
                        Boolean(savingGroups[group.groupKey]) ||
                        applyKeepCount.isPending ||
                        scanBusy
                      }
                      decisionSummary={
                        decisionSummaries[group.groupKey] ?? {
                          complete: false,
                          deletePhotoIds: [],
                          keepPhotoIds: [],
                          undecidedCount: group.photoCount,
                        }
                      }
                      decisions={decisionsByGroup[group.groupKey] ?? {}}
                      detailError={currentDetailState.error}
                      enabled={
                        enabledGroups[group.groupKey] !== undefined &&
                        enabledGroups[group.groupKey] === group.reviewRevision
                      }
                      group={group}
                      loadingPhotos={currentDetailState.loading}
                      onApplyKeepCount={(count) =>
                        requestApplyKeepCount(group, count)
                      }
                      onDecisionChange={(photoId, decision) => {
                        saveDecisions(group, [{ photoId, decision }]);
                      }}
                      onDismiss={() => dismiss.mutate(group)}
                      onLoadMore={() => loadGroupPhotos(group.groupKey)}
                      onPreview={(photoId) =>
                        setPreviewState({
                          groupKey: group.groupKey,
                          photoId,
                        })
                      }
                      onToggleEnabled={() => {
                        if (
                          enabledGroups[group.groupKey] === group.reviewRevision
                        ) {
                          setEnabledGroups((previous) => ({
                            ...previous,
                            [group.groupKey]: undefined,
                          }));
                          return;
                        }
                        saveDecisions(
                          group,
                          Object.entries(group.reviewDecisions ?? {}).map(
                            ([photoId, decision]) => ({
                              photoId: Number(photoId),
                              decision,
                            })
                          ),
                          true
                        );
                      }}
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

      {previewState && previewIndex >= 0 ? (
        <PhotoLightbox
          initialIndex={previewIndex}
          onClose={() => setPreviewState(null)}
          open
          photos={previewPhotos}
          showThumbnailsInitially
        />
      ) : null}

      <ConfirmDialog
        confirmText={t("duplicateConfirmCleanup")}
        description={
          cleanupPlan
            ? t("duplicateCleanupDescription", {
                exactCount: cleanupPlan.groups
                  .filter((group) => group.matchType === "exact")
                  .reduce(
                    (total, group) => total + group.deletePhotoIds.length,
                    0
                  ),
                exactGroups: cleanupPlan.groups.filter(
                  (group) => group.matchType === "exact"
                ).length,
                groups: cleanupPlan.groups.length,
                count: cleanupPlan.deleteCount,
                similarCount: cleanupPlan.groups
                  .filter((group) => group.matchType === "similar")
                  .reduce(
                    (total, group) => total + group.deletePhotoIds.length,
                    0
                  ),
                similarGroups: cleanupPlan.groups.filter(
                  (group) => group.matchType === "similar"
                ).length,
                size: formatFileSize(cleanupPlan.deleteBytes),
              })
            : undefined
        }
        destructive
        disabled={executeCleanupPlan.isPending}
        onCancel={() => {
          if (!executeCleanupPlan.isPending) {
            setCleanupDialogOpen(false);
          }
        }}
        onConfirm={() => {
          if (cleanupPlan) {
            executeCleanupPlan.mutate(cleanupPlan.planId);
          }
        }}
        open={cleanupDialogOpen}
        title={t("duplicateCleanupTitle")}
      />

      <ConfirmDialog
        confirmText={t("duplicateKeepCountConfirm")}
        description={
          keepCountRequest
            ? t("duplicateKeepCountDescription", {
                count: keepCountRequest.count,
                deleteCount:
                  keepCountRequest.group.photoCount - keepCountRequest.count,
              })
            : undefined
        }
        disabled={applyKeepCount.isPending}
        onCancel={() => {
          if (!applyKeepCount.isPending) {
            setKeepCountRequest(null);
          }
        }}
        onConfirm={() => {
          if (keepCountRequest) {
            applyKeepCount.mutate(keepCountRequest);
          }
        }}
        open={keepCountRequest !== null}
        title={t("duplicateKeepCountTitle")}
      />
    </div>
  );
}

export const Route = createFileRoute("/duplicates")({
  component: DuplicatesPage,
});
