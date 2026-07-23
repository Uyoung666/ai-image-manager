import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronUp, Layers, Timer } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  buildPhotoGroupHeaders,
  hasMatchingPhotoGroupPrefix,
  type PhotoGroupInputSnapshot,
  snapshotPhotoGroupInputs,
} from "@/utils/photo-group-headers";
import type { GroupHeader, MasonryGridHandle } from "./MasonryGrid";
import { MasonryGrid } from "./MasonryGrid";
import { PhotoCard } from "./PhotoCard";
import { SequenceCard } from "./SequenceCard";
import type { PhotoSequence, PhotoSequenceDetail } from "@/types/photo-sequence";
import { SortDropdown } from "./SortDropdown";
import { LoadingSpinner } from "./ui/loading-spinner";
import { Skeleton } from "./ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

interface Photo {
  dominantColors?: string | null;
  fileDate?: number | null;
  filename: string;
  fileSize: number;
  height: number;
  id: number;
  isFavorite?: boolean;
  isIndexed: boolean;
  path: string;
  similarity?: number;
  thumbnailSmallPath?: string | null;
  thumbnailPath: string | null;
  width: number;
}

interface SequenceTrayPhoto extends Photo {
  fullWidth: true;
  sequenceTray: PhotoSequenceDetail;
  trayColumns: number;
}

type DisplayPhoto = Photo | SequenceTrayPhoto;
export type SortField = "date" | "name" | "size";
export type SortOrder = "asc" | "desc";

interface PhotoGridProps {
  columnWidth?: number;
  deletingIds?: Set<number>;
  emptyState?: React.ReactNode;
  error?: string;
  /** MasonryGrid 命令式 ref，用于原子化滚动定位 */
  gridRef?: React.RefObject<MasonryGridHandle | null>;
  /** 是否还有更多数据可加载（对应 infinite scroll 的 hasNextPage） */
  hasMore?: boolean;
  /** 正在加载更多数据（useInfiniteQuery 的 isFetchingNextPage） */
  isLoadingMore?: boolean;
  /**
   * 是否为占位数据（keepPreviousData 期间的旧缓存）。
   * 为 true 时 MasonryGrid 会锁死滚动恢复和锚点调整，
   * 避免基于假数据做错误定位。
   */
  isPlaceholderData?: boolean;
  /** 当搜索/浏览切换时数据尚未同步，显示半透明遮罩以避免闪烁 */
  isStale?: boolean;
  loading: boolean;
  onBackgroundClick?: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDoubleClick: (id: number) => void;
  onEndReached?: () => void;
  onKeyboardSelect?: (id: number) => void;
  onMarqueeSelect?: (ids: Set<number>) => void;
  onScrollTopChange?: (scrollTop: number) => void;
  onSelect: (id: number, event: React.MouseEvent) => void;
  onSortChange?: (sort: SortField, order: SortOrder) => void;
  onToggleFavorite?: (id: number) => void;
  photos: Photo[];
  /**
   * 路由唯一标识，用于区分不同页面的滚动位置
   * 例如: "home" | "album-123" | "person-456"
   */
  routeKey: string;
  searchQuery?: string;
  sequenceMode?: "photos" | "sequences";
  sequences?: PhotoSequence[];
  onOpenSequence?: (sequenceId: number) => void;
  onOpenSequenceDetails?: (sequenceId: number) => void;
  onSequenceModeChange?: (mode: "photos" | "sequences") => void;
  expandedSequence?: PhotoSequenceDetail | null;
  expandingSequenceId?: number | null;
  onToggleSequenceExpand?: (sequenceId: number) => void;
  selectedIds: Set<number>;
  showToolbar?: boolean;
  sort?: SortField;
  sortOrder?: SortOrder;
  topInset?: number;
}

const MIN_COLUMNS = 2;
export const GRID_COLUMN_WIDTH_MIN = 140;
export const GRID_COLUMN_WIDTH_MAX = 320;
export const GRID_COLUMN_WIDTH_DEFAULT = 220;
const GAP = 8;
const INITIAL_EAGER_ROWS = 2;

export const GRID_COLUMN_WIDTH_KEY = "grid_column_width";

function createSequenceTray(
  sequence: PhotoSequenceDetail,
  containerWidth: number,
  columns: number
): SequenceTrayPhoto | null {
  const representative =
    sequence.members.find((photo) => photo.id === sequence.representativePhotoId) ??
    sequence.members[0];
  if (!representative) {
    return null;
  }
  const gap = 8;
  const padding = 24;
  const tileWidth = Math.max(
    1,
    (containerWidth - padding - gap * (columns - 1)) / columns
  );
  const gridHeight = sequence.members.reduce((total, photo, index) => {
    if (index % columns !== 0) {
      return total;
    }
    const row = sequence.members.slice(index, index + columns);
    const rowHeight = Math.max(
      ...row.map((member) => {
        const aspect = Math.max(
          0.6,
          Math.min(member.width / member.height || 4 / 3, 3)
        );
        return tileWidth / aspect;
      })
    );
    return total + rowHeight + (index === 0 ? 0 : gap);
  }, 0);
  return {
    ...representative,
    fullWidth: true,
    height: 56 + padding + gridHeight,
    id: -sequence.id,
    sequenceTray: sequence,
    trayColumns: columns,
    width: containerWidth,
  };
}

export function loadGridColumnWidth(): number {
  try {
    const raw = localStorage.getItem(GRID_COLUMN_WIDTH_KEY);
    if (raw !== null) {
      const val = Number(raw);
      if (
        !Number.isNaN(val) &&
        val >= GRID_COLUMN_WIDTH_MIN &&
        val <= GRID_COLUMN_WIDTH_MAX
      ) {
        return val;
      }
    }
  } catch {
    /* ignore */
  }
  return GRID_COLUMN_WIDTH_DEFAULT;
}

interface SequenceFocusTrayProps {
  columns: number;
  getDragIds: (id: number) => number[];
  onDoubleClick: (id: number) => void;
  onSelect: (id: number, event: React.MouseEvent) => void;
  onToggleFavorite?: (id: number) => void;
  onToggleSequenceExpand?: (sequenceId: number) => void;
  renderImage: boolean;
  searchQuery?: string;
  selectedIds: Set<number>;
  sequence: PhotoSequenceDetail;
}

function SequenceFocusTray({
  columns,
  getDragIds,
  onDoubleClick,
  onSelect,
  onToggleFavorite,
  onToggleSequenceExpand,
  renderImage,
  searchQuery,
  selectedIds,
  sequence,
}: SequenceFocusTrayProps) {
  const { t } = useTranslation();
  return (
    <section className="animate-in fade-in-0 slide-in-from-top-2 rounded-[10px] border-2 border-primary/50 bg-primary/[0.06] p-3 shadow-sm duration-200">
      <header className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-primary">
          {sequence.type === "burst" ? (
            <Layers className="h-4 w-4 shrink-0" />
          ) : (
            <Timer className="h-4 w-4 shrink-0" />
          )}
          <span className="truncate font-medium text-[13px]">
            {t(sequence.type === "burst" ? "sequenceBurst" : "sequenceTimelapse")}
            {` · ${sequence.frameCount} ${t("sequenceFrames")}`}
          </span>
        </div>
        {onToggleSequenceExpand && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                aria-label={t("sequenceCollapse")}
                className="flex h-8 shrink-0 items-center gap-1 rounded-md border border-primary/30 bg-background/80 px-2 text-[12px] text-foreground hover:bg-primary/10"
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleSequenceExpand(sequence.id);
                }}
                type="button"
              >
                <ChevronUp size={16} />
                {t("sequenceCollapse")}
              </button>
            </TooltipTrigger>
            <TooltipContent>{t("sequenceCollapse")}</TooltipContent>
          </Tooltip>
        )}
      </header>
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {sequence.members.map((member, index) => (
          <PhotoCard
            dominantColors={member.dominantColors}
            filename={member.filename}
            getDragIds={getDragIds}
            height={member.height}
            id={member.id}
            isFavorite={member.isFavorite}
            isSelected={selectedIds.has(member.id)}
            key={member.id}
            loading={index < columns * INITIAL_EAGER_ROWS ? "eager" : "lazy"}
            onClick={onSelect}
            onDoubleClick={onDoubleClick}
            onToggleFavorite={onToggleFavorite}
            path={member.path}
            renderImage={renderImage}
            searchQuery={searchQuery}
            thumbnailPath={member.thumbnailPath}
            width={member.width}
          />
        ))}
      </div>
    </section>
  );
}

export const PhotoGrid = memo(
  function PhotoGrid({
    photos,
    columnWidth,
    loading,
    isLoadingMore = false,
    selectedIds,
    deletingIds,
    gridRef,
    routeKey,
    searchQuery,
    sort = "date",
    sortOrder = "desc",
    emptyState,
    error,
    isPlaceholderData = false,
    isStale = false,
    onSelect,
    onDoubleClick,
    onContextMenu,
    onEndReached,
    hasMore = false,
    onSortChange,
    onToggleFavorite,
    onKeyboardSelect,
    onMarqueeSelect,
    onScrollTopChange,
    onBackgroundClick,
    showToolbar = true,
    topInset = 0,
    sequences = [],
    sequenceMode = "photos",
    onOpenSequence,
    onOpenSequenceDetails,
    onSequenceModeChange,
    expandedSequence,
    expandingSequenceId,
    onToggleSequenceExpand,
  }: PhotoGridProps) {
    const { t, i18n } = useTranslation();
    const [internalColumnWidth, setInternalColumnWidth] =
      useState(loadGridColumnWidth);
    const targetColWidth = columnWidth ?? internalColumnWidth;
    const [columnCount, setColumnCount] = useState(4);
    const [containerWidth, setContainerWidth] = useState(0);
    const containerRef = useRef<HTMLDivElement>(null);
    const observerRef = useRef<ResizeObserver | null>(null);
    const targetColWidthRef = useRef(targetColWidth);
    targetColWidthRef.current = targetColWidth;
    const metricsRef = useRef({
      columnCount: 4,
      width: 0,
    });
    // selectedIds/deletingIds 通过 ref 传递，稳定 renderItem 引用。
    // 移除 deps 中的 Set 依赖 → 选中操作仅触发实际变化卡片的 memo 比较。
    const selectedIdsRef = useRef(selectedIds);
    selectedIdsRef.current = selectedIds;
    const sequenceByRepresentative = useMemo(() => new Map(sequences.map((sequence) => [sequence.representativePhotoId ?? sequence.photo.id, sequence])), [sequences]);
    const sequenceMemberIds = useMemo(() => new Set(sequences.flatMap((sequence) => sequence.memberPhotoIds ?? [])), [sequences]);
    const displayPhotos = useMemo<DisplayPhoto[]>(() => {
      const trayColumns = Math.max(2, Math.min(columnCount, 6));
      const tray = expandedSequence
        ? createSequenceTray(expandedSequence, containerWidth, trayColumns)
        : null;
      if (sequenceMode === "sequences") {
        const visible = sequences.map((sequence) => sequence.photo);
        if (!expandedSequence || !tray) {
          return visible;
        }
        const representativeId =
          expandedSequence.representativePhotoId ??
          expandedSequence.members[0]?.id;
        const representativeIndex = visible.findIndex(
          (photo) => photo.id === representativeId
        );
        if (representativeIndex < 0) {
          return visible;
        }
        return [
          ...visible.slice(0, representativeIndex),
          tray,
          ...visible.slice(representativeIndex + 1),
        ];
      }
      const visible = photos.filter(
        (photo) =>
          !sequenceMemberIds.has(photo.id) ||
          sequenceByRepresentative.has(photo.id)
      );
      const visibleIds = new Set(visible.map((photo) => photo.id));
      for (const sequence of sequences) {
        const hasMatchingMember = (sequence.memberPhotoIds ?? []).some((id) =>
          photos.some((photo) => photo.id === id)
        );
        if (hasMatchingMember && !visibleIds.has(sequence.photo.id)) {
          visible.push(sequence.photo);
        }
      }
      if (!expandedSequence || !tray) {
        return visible;
      }
      const representativeId =
        expandedSequence.representativePhotoId ?? expandedSequence.members[0]?.id;
      const representativeIndex = visible.findIndex(
        (photo) => photo.id === representativeId
      );
      if (representativeIndex < 0) {
        return visible;
      }
      return [
        ...visible.slice(0, representativeIndex),
        tray,
        ...visible.slice(representativeIndex + 1),
      ];
    }, [photos, sequenceMode, sequenceMemberIds, sequenceByRepresentative, sequences, expandedSequence, columnCount, containerWidth]);
    const keyboardPhotos = useMemo(
      () =>
        displayPhotos.flatMap((photo) =>
          "sequenceTray" in photo ? photo.sequenceTray.members : [photo]
        ),
      [displayPhotos]
    );
    const deletingIdsRef = useRef(deletingIds);
    deletingIdsRef.current = deletingIds;
    const itemStateVersion = useMemo(
      () => ({ deletingIds, selectedIds }),
      [deletingIds, selectedIds]
    );
    const groupHeaderCacheRef = useRef<{
      headers: GroupHeader[];
      language: string;
      photoSnapshot: PhotoGroupInputSnapshot[];
      routeKey: string;
      sort: SortField;
    } | null>(null);

    const applyGridMetrics = useCallback((width: number) => {
      const nextColumnCount = Math.max(
        MIN_COLUMNS,
        Math.floor(width / targetColWidthRef.current)
      );
      const prev = metricsRef.current;
      if (prev.width !== width) {
        metricsRef.current = { ...metricsRef.current, width };
        setContainerWidth(width);
      }
      if (prev.columnCount !== nextColumnCount) {
        metricsRef.current = {
          ...metricsRef.current,
          columnCount: nextColumnCount,
        };
        setColumnCount(nextColumnCount);
      }
    }, []);

    const containerCallbackRef = useCallback(
      (node: HTMLDivElement | null) => {
        if (observerRef.current) {
          observerRef.current.disconnect();
          observerRef.current = null;
        }
        containerRef.current = node;
        if (!node) {
          return;
        }
        // Set initial width synchronously so MasonryGrid never renders with
        // containerWidth=0 (avoids a blank first frame while waiting for the
        // async ResizeObserver callback).
        const w = node.clientWidth;
        applyGridMetrics(w);
        // ResizeObserver for subsequent size changes.
        const observer = new ResizeObserver(([entry]) => {
          applyGridMetrics(entry.contentRect.width);
        });
        observer.observe(node);
        observerRef.current = observer;
      },
      [applyGridMetrics]
    );

    useEffect(() => {
      const el = containerRef.current;
      if (!el) {
        return;
      }
      const cols = Math.max(
        MIN_COLUMNS,
        Math.floor(containerWidth / targetColWidth)
      );
      if (metricsRef.current.columnCount !== cols) {
        metricsRef.current = { ...metricsRef.current, columnCount: cols };
        setColumnCount(cols);
      }
    }, [targetColWidth, containerWidth]);

    // Track the single selected photo id for scroll-to behavior
    const scrollToId = useMemo(() => {
      if (expandedSequence) {
        return -expandedSequence.id;
      }
      if (selectedIds.size === 1) {
        return [...selectedIds][0];
      }
      return null;
    }, [expandedSequence, selectedIds]);

    // Keyboard navigation (arrow keys)
    useEffect(() => {
      if (!onKeyboardSelect || keyboardPhotos.length === 0) {
        return;
      }
      function handleKeyDown(e: KeyboardEvent) {
        if (
          e.target instanceof HTMLInputElement ||
          e.target instanceof HTMLTextAreaElement
        ) {
          return;
        }
        const arrows = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
        if (!arrows.includes(e.key)) {
          return;
        }

        e.preventDefault();
        const currentId = selectedIds.size === 1 ? [...selectedIds][0] : null;
        let currentIdx = currentId
          ? keyboardPhotos.findIndex((p) => p.id === currentId)
          : -1;
        if (currentIdx < 0) {
          currentIdx = 0;
        }

        let nextIdx = currentIdx;
        if (e.key === "ArrowRight") {
          nextIdx = Math.min(keyboardPhotos.length - 1, currentIdx + 1);
        } else if (e.key === "ArrowLeft") {
          nextIdx = Math.max(0, currentIdx - 1);
        } else if (e.key === "ArrowDown") {
          nextIdx = Math.min(keyboardPhotos.length - 1, currentIdx + columnCount);
        } else if (e.key === "ArrowUp") {
          nextIdx = Math.max(0, currentIdx - columnCount);
        }

        if (nextIdx !== currentIdx || currentId === null) {
          onKeyboardSelect!(keyboardPhotos[nextIdx].id);
        }
      }
      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }, [keyboardPhotos, selectedIds, columnCount, onKeyboardSelect]);

    const skeletonAspects = useCallback(
      () => [3 / 4, 4 / 3, 1 / 1, 3 / 2, 2 / 3],
      []
    );

    const getDragIds = useCallback((id: number) => {
      const current = selectedIdsRef.current;
      return current.has(id) ? [...current] : [id];
    }, []);

    const renderItem = useCallback(
      (
        photo: DisplayPhoto,
        index: number,
        _style: React.CSSProperties,
        options: { renderImage: boolean }
      ) => {
        if ("sequenceTray" in photo) {
          return (
            <SequenceFocusTray
              columns={photo.trayColumns}
              getDragIds={getDragIds}
              onDoubleClick={onDoubleClick}
              onSelect={onSelect}
              onToggleFavorite={onToggleFavorite}
              onToggleSequenceExpand={onToggleSequenceExpand}
              renderImage={options.renderImage}
              searchQuery={searchQuery}
              selectedIds={selectedIdsRef.current}
              sequence={photo.sequenceTray}
            />
          );
        }
        const sequence = sequenceByRepresentative.get(photo.id);
        if (!options.renderImage) {
          return (
            <div
              aria-hidden="true"
              className="h-full w-full overflow-hidden rounded-[8px] bg-muted"
              data-photo-id={photo.id}
              data-photo-path={photo.path}
            />
          );
        }
        if (
          sequence &&
          sequence.id !== expandedSequence?.id &&
          onOpenSequence &&
          onOpenSequenceDetails
        ) {
          return <SequenceCard expanded={false} expanding={expandingSequenceId === sequence.id} isSelected={selectedIdsRef.current.has(photo.id)} onClick={onSelect} onOpen={onOpenSequence} onOpenDetails={onOpenSequenceDetails} onToggleExpand={onToggleSequenceExpand} sequence={sequence} />;
        }
        const photoCard = (
          <PhotoCard
            deleting={deletingIdsRef.current?.has(photo.id)}
            dominantColors={photo.dominantColors}
            filename={photo.filename}
            getDragIds={getDragIds}
            height={photo.height}
            id={photo.id}
            isFavorite={photo.isFavorite}
            isSelected={selectedIdsRef.current.has(photo.id)}
            loading={
              index < columnCount * INITIAL_EAGER_ROWS ? "eager" : "lazy"
            }
            onClick={onSelect}
            onDoubleClick={onDoubleClick}
            onToggleFavorite={onToggleFavorite}
            path={photo.path}
            searchQuery={searchQuery}
            similarity={photo.similarity}
            thumbnailSmallPath={photo.thumbnailSmallPath}
            thumbnailPath={photo.thumbnailPath}
            width={photo.width}
          />
        );
        const representativeId =
          expandedSequence?.representativePhotoId ??
          expandedSequence?.members[0]?.id;
        if (
          expandedSequence &&
          photo.id === representativeId &&
          onToggleSequenceExpand
        ) {
          return (
            <div className="relative h-full w-full">
              {photoCard}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    aria-label={t("sequenceCollapse")}
                    className="absolute top-2 right-2 z-10 flex h-8 w-8 items-center justify-center rounded-md bg-black/65 text-white shadow backdrop-blur transition-colors hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onToggleSequenceExpand(expandedSequence.id);
                    }}
                    type="button"
                  >
                    <ChevronUp size={17} />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{t("sequenceCollapse")}</TooltipContent>
              </Tooltip>
            </div>
          );
        }
        return photoCard;
      },
      [
        onSelect,
        onDoubleClick,
        onToggleFavorite,
        searchQuery,
        getDragIds,
        columnCount, sequenceByRepresentative, onOpenSequence, onOpenSequenceDetails,
        expandedSequence, expandingSequenceId, onToggleSequenceExpand, sequenceMode, t,
      ]
    );

    const groupHeaders = useMemo((): GroupHeader[] => {
      if (sort !== "date" || displayPhotos.length === 0) {
        groupHeaderCacheRef.current = null;
        return [];
      }

      const cached = groupHeaderCacheRef.current;
      const cacheContextMatches =
        cached?.sort === sort &&
        cached.language === i18n.language &&
        cached.routeKey === routeKey;
      if (
        cacheContextMatches &&
        cached.photoSnapshot.length === displayPhotos.length &&
        hasMatchingPhotoGroupPrefix(cached.photoSnapshot, displayPhotos)
      ) {
        return cached.headers;
      }

      let startIndex = 0;
      let existingHeaders: GroupHeader[] = [];
      if (
        cacheContextMatches &&
        cached.photoSnapshot.length < displayPhotos.length &&
        hasMatchingPhotoGroupPrefix(cached.photoSnapshot, displayPhotos)
      ) {
        existingHeaders = cached.headers;
        startIndex = cached.photoSnapshot.length;
      }
      const headers = buildPhotoGroupHeaders(
        displayPhotos,
        i18n.language,
        startIndex,
        existingHeaders
      );
      groupHeaderCacheRef.current = {
        headers,
        language: i18n.language,
        photoSnapshot: snapshotPhotoGroupInputs(displayPhotos),
        routeKey,
        sort,
      };
      return headers;
    }, [displayPhotos, sort, i18n.language, routeKey]);

    if (loading && displayPhotos.length === 0) {
      const skelCols = Array.from({ length: columnCount }, (_, ci) =>
        Array.from({ length: 3 }, (_, ri) => ci * 3 + ri)
      );
      return (
        <div className="flex flex-1 flex-col">
          {showToolbar && (
            <div className="flex items-center justify-between border-border border-b px-4 py-2">
              <Skeleton className="h-4 w-24 bg-card" />
              <div className="flex items-center gap-1.5">
                <Skeleton className="h-2.5 w-8 rounded-[2px] bg-card" />
                <Skeleton className="h-4 w-20 rounded-[4px] bg-card" />
              </div>
            </div>
          )}
          <div className="flex-1 overflow-y-auto px-2 pt-2">
            <div className="flex gap-2">
              {skelCols.map((items, ci) => (
                <div className="flex flex-1 flex-col gap-2" key={ci}>
                  {items.map((i) => (
                    <Skeleton
                      className="w-full rounded-[8px] bg-muted"
                      key={i}
                      style={{
                        aspectRatio:
                          skeletonAspects()[i % skeletonAspects().length],
                      }}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      );
    }

    if (!loading && displayPhotos.length === 0) {
      const isError = !!error;
      return (
        <div className="flex flex-1 flex-col">
          {showToolbar && (
            <div className="flex items-center justify-between border-border border-b px-4 py-2">
              <span className="truncate text-[12px] text-muted-foreground">
                {t("photosCount", { count: 0 })}
              </span>
            </div>
          )}
          <div className="flex flex-1 items-center justify-center">
            {isError ? (
              <div className="flex flex-col items-center gap-3 px-6 text-center">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-danger/10">
                  <svg
                    aria-hidden="true"
                    className="h-5 w-5 text-danger"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    viewBox="0 0 24 24"
                  >
                    <path
                      d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
                <p className="text-[13px] text-muted-foreground/70">{error}</p>
              </div>
            ) : (
              (emptyState ?? (
                <span className="text-[13px] text-muted-foreground/70">
                  {t("noPhotos")}
                </span>
              ))
            )}
          </div>
        </div>
      );
    }

    return (
      <div
        className="relative flex flex-1 flex-col"
        onClick={(e) => {
          if (onBackgroundClick) {
            const target = e.target as HTMLElement;
            // 只有点击非照片卡片区域才触发背景点击
            if (!target.closest("[data-photo-id]")) {
              onBackgroundClick();
            }
          }
        }}
      >
        {/* Floating glass toolbar — 悬浮毛玻璃工具条 */}
        {/* Masonry grid */}
        {showToolbar && (
          <div
            className="glass-surface absolute top-0 right-0 left-0 z-50 flex items-center justify-between border-border border-b px-4 py-2"
            onClick={(event) => event.stopPropagation()}
          >
            <span className="truncate text-[12px] text-muted-foreground">
              {t("photosCount", { count: displayPhotos.length.toLocaleString() })}
              {selectedIds.size > 0 &&
                t("photosSelected", { count: selectedIds.size })}
            </span>
            <div className="flex items-center gap-2">
              {onSequenceModeChange && (
                <div className="flex rounded-md border border-border p-0.5 text-[11px]">
                  <button className={`rounded px-2 py-1 ${sequenceMode === "photos" ? "bg-muted text-foreground" : "text-muted-foreground"}`} onClick={() => onSequenceModeChange("photos")} type="button">照片</button>
                  <button className={`rounded px-2 py-1 ${sequenceMode === "sequences" ? "bg-muted text-foreground" : "text-muted-foreground"}`} onClick={() => onSequenceModeChange("sequences")} type="button">序列</button>
                </div>
              )}
              {onSortChange && (
                <SortDropdown
                  onChange={onSortChange}
                  order={sortOrder}
                  sort={sort}
                />
              )}
              <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground/70">
                <span>{t("gridSize")}</span>
                <input
                  aria-label={t("gridSize")}
                  className="h-4 w-20 cursor-pointer accent-primary"
                  max={GRID_COLUMN_WIDTH_MAX}
                  min={GRID_COLUMN_WIDTH_MIN}
                  onChange={(event) => {
                    const width = Number(event.target.value);
                    setInternalColumnWidth(width);
                    try {
                      localStorage.setItem(
                        GRID_COLUMN_WIDTH_KEY,
                        String(width)
                      );
                    } catch {
                      // Keep the in-memory preference.
                    }
                  }}
                  step={10}
                  type="range"
                  value={targetColWidth}
                />
              </label>
            </div>
          </div>
        )}
        <div
          className="min-h-0 flex-1"
          onContextMenu={onContextMenu}
          ref={containerCallbackRef}
          style={{
            opacity: isStale ? 0.6 : 1,
            transition: "opacity 0.15s ease",
          }}
        >
          <MasonryGrid
            className={`scrollbar-thin px-2 ${showToolbar ? "pt-12" : topInset > 0 ? "" : "pt-2"} ${selectedIds.size > 0 ? "pb-[var(--selection-action-avoid-bottom)]" : "pb-2"}`}
            columnCount={columnCount}
            containerWidth={containerWidth - 16}
            gap={GAP}
            groupHeaders={groupHeaders}
            hasMore={hasMore}
            isLoadingMore={isLoadingMore}
            isPlaceholderData={isPlaceholderData}
            itemStateVersion={itemStateVersion}
            items={displayPhotos}
            onEndReached={onEndReached}
            onMarqueeSelect={onMarqueeSelect}
            onScrollTopChange={onScrollTopChange}
            ref={gridRef}
            renderItem={renderItem}
            routeKey={routeKey}
            scrollToAlignment={expandedSequence ? "start" : "center"}
            scrollToId={scrollToId}
            selectionActive={selectedIds.size > 0}
            topInset={topInset}
          />
        </div>

        {/* Loading overlay */}
        {loading && displayPhotos.length > 0 && (
          <div className="pointer-events-none absolute top-0 right-0 bottom-0 left-0 flex items-start justify-center bg-background/30 pt-4">
            <LoadingSpinner size="lg" />
          </div>
        )}
      </div>
    );
  },
  (prevProps, nextProps) => {
    if (prevProps.columnWidth !== nextProps.columnWidth) {
      return false;
    }
    if (prevProps.photos !== nextProps.photos) {
      return false;
    }
    if (prevProps.sequences !== nextProps.sequences) {
      return false;
    }
    if (prevProps.sequenceMode !== nextProps.sequenceMode) {
      return false;
    }
    if (prevProps.onOpenSequence !== nextProps.onOpenSequence) {
      return false;
    }
    if (prevProps.onOpenSequenceDetails !== nextProps.onOpenSequenceDetails) {
      return false;
    }
    if (prevProps.expandedSequence !== nextProps.expandedSequence) {
      return false;
    }
    if (prevProps.expandingSequenceId !== nextProps.expandingSequenceId) {
      return false;
    }
    if (prevProps.onToggleSequenceExpand !== nextProps.onToggleSequenceExpand) {
      return false;
    }
    if (prevProps.loading !== nextProps.loading) {
      return false;
    }
    if (prevProps.isLoadingMore !== nextProps.isLoadingMore) {
      return false;
    }
    if (prevProps.selectedIds !== nextProps.selectedIds) {
      return false;
    }
    if (prevProps.deletingIds !== nextProps.deletingIds) {
      return false;
    }
    if (prevProps.routeKey !== nextProps.routeKey) {
      return false;
    }
    if (prevProps.searchQuery !== nextProps.searchQuery) {
      return false;
    }
    if (prevProps.sort !== nextProps.sort) {
      return false;
    }
    if (prevProps.sortOrder !== nextProps.sortOrder) {
      return false;
    }
    if (prevProps.isPlaceholderData !== nextProps.isPlaceholderData) {
      return false;
    }
    if (prevProps.isStale !== nextProps.isStale) {
      return false;
    }
    if (prevProps.error !== nextProps.error) {
      return false;
    }
    if (prevProps.hasMore !== nextProps.hasMore) {
      return false;
    }
    if (prevProps.showToolbar !== nextProps.showToolbar) {
      return false;
    }
    if (prevProps.onScrollTopChange !== nextProps.onScrollTopChange) {
      return false;
    }
    if (prevProps.topInset !== nextProps.topInset) {
      return false;
    }
    return true;
  }
);
