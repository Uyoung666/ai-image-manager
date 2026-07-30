import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowLeft,
  ArrowRight,
  ChevronUp,
  Layers,
  Scissors,
  Timer,
  Unlink,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { photoSequenceActions } from "@/actions/photo-sequences";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import type { SearchMatch } from "@/types/photo";
import type {
  PhotoSequence,
  PhotoSequenceDetail,
} from "@/types/photo-sequence";
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
  match?: SearchMatch;
  path: string;
  thumbnailPath: string | null;
  thumbnailSmallPath?: string | null;
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
  expandedSequence?: PhotoSequenceDetail | null;
  expandedSequenceComplete?: PhotoSequenceDetail | null;
  expandingSequenceId?: number | null;
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
  onOpenSequence?: (sequenceId: number) => void;
  onOpenSequenceDetails?: (sequenceId: number) => void;
  onRestoreSettled?: (routeKey: string) => void;
  onScrollTopChange?: (scrollTop: number) => void;
  onSelect: (id: number, event: React.MouseEvent) => void;
  onSelectSequence?: (memberIds: number[], event: React.MouseEvent) => void;
  onSelectSequenceMembers?: (memberIds: number[], selectAll: boolean) => void;
  onSequenceMutationComplete?: () => void;
  onSequenceModeChange?: (mode: "photos" | "sequences") => void;
  onSortChange?: (sort: SortField, order: SortOrder) => void;
  onToggleFavorite?: (id: number) => void;
  onToggleSequenceExpand?: (sequenceId: number) => void;
  photos: Photo[];
  restoreGateReady?: boolean;
  /**
   * 路由唯一标识，用于区分不同页面的滚动位置
   * 例如: "home" | "album-123" | "person-456"
   */
  routeKey: string;
  searchQuery?: string;
  selectedIds: Set<number>;
  sequenceMode?: "photos" | "sequences";
  sequences?: PhotoSequence[];
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
const SEQUENCE_TRAY_GAP = 8;
const SEQUENCE_TRAY_MAX_HEIGHT = 560;
const SEQUENCE_TRAY_MANAGEMENT_HEIGHT = 40;
const SEQUENCE_TRAY_PADDING = 24;

function scopedSequenceMemberIds(sequence: PhotoSequence): number[] {
  return sequence.matchedPhotoIds ?? sequence.memberPhotoIds ?? [];
}

function getSequenceRowHeight(
  members: PhotoSequenceDetail["members"],
  containerWidth: number,
  columns: number,
  rowIndex: number
) {
  const tileWidth = Math.max(
    1,
    (containerWidth -
      SEQUENCE_TRAY_PADDING -
      SEQUENCE_TRAY_GAP * (columns - 1)) /
      columns
  );
  const row = members.slice(rowIndex * columns, (rowIndex + 1) * columns);
  return (
    Math.max(
      ...row.map((member) => {
        const aspect = Math.max(
          0.6,
          Math.min(member.width / member.height || 4 / 3, 3)
        );
        return tileWidth / aspect;
      }),
      1
    ) + SEQUENCE_TRAY_GAP
  );
}

function getSequenceGridHeight(
  members: PhotoSequenceDetail["members"],
  containerWidth: number,
  columns: number
) {
  const rowCount = Math.ceil(members.length / columns);
  return Array.from({ length: rowCount }, (_, rowIndex) =>
    getSequenceRowHeight(members, containerWidth, columns, rowIndex)
  ).reduce((total, height) => total + height, 0);
}

export const GRID_COLUMN_WIDTH_KEY = "grid_column_width";

function createSequenceTray(
  sequence: PhotoSequenceDetail,
  containerWidth: number,
  columns: number
): SequenceTrayPhoto | null {
  const representative =
    sequence.members.find(
      (photo) => photo.id === sequence.representativePhotoId
    ) ?? sequence.members[0];
  if (!representative) {
    return null;
  }
  const gridHeight = getSequenceGridHeight(
    sequence.members,
    containerWidth,
    columns
  );
  return {
    ...representative,
    fullWidth: true,
    height:
      56 +
      SEQUENCE_TRAY_PADDING +
      SEQUENCE_TRAY_MANAGEMENT_HEIGHT +
      Math.min(gridHeight, SEQUENCE_TRAY_MAX_HEIGHT),
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

export interface SequenceFocusTrayProps {
  columns: number;
  completeMembers?: readonly Photo[];
  containerWidth: number;
  getDragIds: (id: number) => number[];
  onDoubleClick: (id: number) => void;
  onSelect: (id: number, event: React.MouseEvent) => void;
  onSelectSequenceMembers?: (memberIds: number[], selectAll: boolean) => void;
  onSequenceMutationComplete?: () => void;
  onToggleFavorite?: (id: number) => void;
  onToggleSequenceExpand?: (sequenceId: number) => void;
  renderImage: boolean;
  searchQuery?: string;
  selectedIds: Set<number>;
  sequence: PhotoSequenceDetail;
}

export function SequenceFocusTray({
  containerWidth,
  columns,
  completeMembers,
  getDragIds,
  onDoubleClick,
  onSelect,
  onSelectSequenceMembers,
  onSequenceMutationComplete,
  onToggleFavorite,
  onToggleSequenceExpand,
  renderImage,
  searchQuery,
  selectedIds,
  sequence,
}: SequenceFocusTrayProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowCount = Math.ceil(sequence.members.length / columns);
  const gridHeight = getSequenceGridHeight(
    sequence.members,
    containerWidth,
    columns
  );
  const virtualizer = useVirtualizer({
    count: rowCount,
    estimateSize: (rowIndex) =>
      getSequenceRowHeight(
        sequence.members,
        containerWidth,
        columns,
        rowIndex
      ),
    getScrollElement: () => scrollRef.current,
    initialRect: {
      height: Math.min(gridHeight, SEQUENCE_TRAY_MAX_HEIGHT),
      width: containerWidth,
    },
    overscan: 2,
  });
  const selectedMemberCount = sequence.members.filter((member) =>
    selectedIds.has(member.id)
  ).length;
  const fullMembers = completeMembers ?? sequence.members;
  const selectedMemberIds = sequence.members
    .filter((member) => selectedIds.has(member.id))
    .map((member) => member.id);
  const selectedFullIndex =
    selectedMemberIds.length === 1
      ? fullMembers.findIndex((member) => member.id === selectedMemberIds[0])
      : -1;
  const [isMutating, setIsMutating] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    confirmText: string;
    description: React.ReactNode;
    operation: () => Promise<unknown>;
    successText: string;
    title: string;
  } | null>(null);
  const dissolveExcludeRef = useRef(false);
  const finishMutation = useCallback(
    async (operation: () => Promise<unknown>, successText: string) => {
      setIsMutating(true);
      try {
        await operation();
        onSelectSequenceMembers?.(
          fullMembers.map((member) => member.id),
          false
        );
        onSequenceMutationComplete?.();
        toast.success(successText);
      } catch (error) {
        console.error("[SequenceFocusTray] mutation failed", error);
        toast.error("序列操作失败");
      } finally {
        setIsMutating(false);
      }
    },
    [fullMembers, onSelectSequenceMembers, onSequenceMutationComplete]
  );
  const handleMove = useCallback(
    (direction: -1 | 1) => {
      if (selectedFullIndex < 0) {
        return;
      }
      const targetIndex = selectedFullIndex + direction;
      if (targetIndex < 0 || targetIndex >= fullMembers.length) {
        return;
      }
      const orderedIds = fullMembers.map((member) => member.id);
      [orderedIds[selectedFullIndex], orderedIds[targetIndex]] = [
        orderedIds[targetIndex],
        orderedIds[selectedFullIndex],
      ];
      finishMutation(
        () => photoSequenceActions.updateMembers(sequence.id, orderedIds),
        "已调整序列顺序"
      );
    },
    [finishMutation, fullMembers, selectedFullIndex, sequence.id]
  );
  const allMembersSelected =
    sequence.members.length > 0 &&
    selectedMemberCount === sequence.members.length;
  let selectionLabel = `${t("selectAll")} (${sequence.members.length})`;
  if (allMembersSelected) {
    selectionLabel = t("clearSelection");
  } else if (selectedMemberCount > 0) {
    selectionLabel = `${selectedMemberCount}/${sequence.members.length}`;
  }
  return (
    <section className="fade-in-0 slide-in-from-top-2 animate-in rounded-[10px] border-2 border-primary/50 bg-primary/[0.06] p-3 shadow-sm duration-200">
      <header className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-primary">
          {sequence.type === "burst" ? (
            <Layers className="h-4 w-4 shrink-0" />
          ) : (
            <Timer className="h-4 w-4 shrink-0" />
          )}
          <span className="truncate font-medium text-[13px]">
            {t(
              sequence.type === "burst" ? "sequenceBurst" : "sequenceTimelapse"
            )}
            {` · ${sequence.frameCount} ${t("sequenceFrames")}`}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onSelectSequenceMembers && (
            <button
              className="h-8 rounded-md border border-border bg-background/80 px-2 text-[12px] text-foreground hover:bg-muted"
              onClick={(event) => {
                event.stopPropagation();
                onSelectSequenceMembers(
                  sequence.members.map((member) => member.id),
                  !allMembersSelected
                );
              }}
              type="button"
            >
              {selectionLabel}
            </button>
          )}
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
        </div>
      </header>
      <div className="mb-3 flex h-7 items-center gap-2 overflow-x-auto">
        <span className="shrink-0 text-[11px] text-muted-foreground">
          序列管理
        </span>
        <button
          className="h-7 shrink-0 rounded-md border border-border bg-background/80 px-2 text-[11px] disabled:opacity-40"
          disabled={isMutating || selectedMemberIds.length === 0}
          onClick={() =>
            setConfirmation({
              confirmText: "移出序列",
              description: `从序列中移出已选 ${selectedMemberIds.length} 张照片。照片文件不会被删除；少于 2 张时序列会自动解散。`,
              operation: () =>
                photoSequenceActions.removeMembers(
                  sequence.id,
                  selectedMemberIds
                ),
              successText: "已移出序列成员",
              title: "确认移出序列",
            })
          }
          type="button"
        >
          <Unlink className="mr-1 inline size-3.5" />
          移出
        </button>
        <button
          aria-label="在序列中前移"
          className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-background/80 disabled:opacity-40"
          disabled={isMutating || selectedFullIndex <= 0}
          onClick={() => handleMove(-1)}
          title="前移"
          type="button"
        >
          <ArrowLeft className="size-3.5" />
        </button>
        <button
          aria-label="在序列中后移"
          className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-background/80 disabled:opacity-40"
          disabled={
            isMutating ||
            selectedFullIndex < 0 ||
            selectedFullIndex >= fullMembers.length - 1
          }
          onClick={() => handleMove(1)}
          title="后移"
          type="button"
        >
          <ArrowRight className="size-3.5" />
        </button>
        <button
          className="h-7 shrink-0 rounded-md border border-border bg-background/80 px-2 text-[11px] disabled:opacity-40"
          disabled={
            isMutating ||
            selectedFullIndex < 2 ||
            selectedFullIndex > fullMembers.length - 2
          }
          onClick={() =>
            setConfirmation({
              confirmText: "拆分序列",
              description: `从已选照片前拆分，生成 ${selectedFullIndex} 张和 ${fullMembers.length - selectedFullIndex} 张两个序列。`,
              operation: () =>
                photoSequenceActions.split(sequence.id, selectedFullIndex),
              successText: "已拆分序列",
              title: "确认拆分序列",
            })
          }
          type="button"
        >
          <Scissors className="mr-1 inline size-3.5" />
          从此拆分
        </button>
        <button
          className="h-7 shrink-0 rounded-md border border-destructive/30 bg-background/80 px-2 text-[11px] text-destructive disabled:opacity-40"
          disabled={isMutating}
          onClick={() => {
            dissolveExcludeRef.current = false;
            setConfirmation({
              confirmText: "解散序列",
              description: (
                <>
                  <p className="mb-3">
                    解散这个 {fullMembers.length}{" "}
                    张照片的序列。照片文件不会被删除。
                  </p>
                  <div className="checkbox-wrapper flex items-center gap-2">
                    <input
                      className="check"
                      defaultChecked={false}
                      id="dissolve-exclude-check"
                      onChange={(e) => {
                        dissolveExcludeRef.current = e.target.checked;
                      }}
                      type="checkbox"
                    />
                    <label
                      className="label flex cursor-pointer items-center gap-2 text-[13px] text-muted-foreground"
                      htmlFor="dissolve-exclude-check"
                    >
                      <svg
                        aria-hidden="true"
                        className="flex-none text-foreground/55"
                        height="40"
                        viewBox="0 0 95 95"
                        width="40"
                      >
                        <rect
                          fill="none"
                          height="50"
                          stroke="currentColor"
                          width="50"
                          x="30"
                          y="20"
                        />
                        <g transform="translate(0,-952.36222)">
                          <path
                            className="path1"
                            d="m 56,963 c -102,122 6,9 7,9 17,-5 -66,69 -38,52 122,-77 -7,14 18,4 29,-11 45,-43 23,-4"
                            fill="none"
                            stroke="var(--danger)"
                            strokeWidth="3"
                          />
                        </g>
                      </svg>
                      不再将此组照片识别为序列
                    </label>
                  </div>
                </>
              ),
              operation: () =>
                dissolveExcludeRef.current
                  ? photoSequenceActions.dissolveAndExclude(sequence.id)
                  : photoSequenceActions.dissolve(sequence.id),
              successText: "序列已解散",
              title: "确认解散序列",
            });
          }}
          type="button"
        >
          <Unlink className="mr-1 inline size-3.5" />
          解散
        </button>
      </div>
      <div
        className="overflow-y-auto overscroll-contain px-1 pt-1"
        data-sequence-virtual-scroll=""
        ref={scrollRef}
        style={{ height: Math.min(gridHeight, SEQUENCE_TRAY_MAX_HEIGHT) }}
      >
        <div
          className="relative w-full"
          data-sequence-virtual-grid=""
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const startIndex = virtualRow.index * columns;
            const rowMembers = sequence.members.slice(
              startIndex,
              startIndex + columns
            );
            return (
              <div
                className="absolute top-0 left-0 grid w-full gap-2"
                data-sequence-virtual-row={virtualRow.index}
                key={virtualRow.key}
                style={{
                  gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                  minHeight: virtualRow.size,
                  paddingBottom: SEQUENCE_TRAY_GAP,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {rowMembers.map((member, columnIndex) => (
                  <PhotoCard
                    dominantColors={member.dominantColors}
                    filename={member.filename}
                    getDragIds={getDragIds}
                    height={member.height}
                    id={member.id}
                    isFavorite={member.isFavorite}
                    isSelected={selectedIds.has(member.id)}
                    key={member.id}
                    loading={
                      startIndex + columnIndex <
                      columns * INITIAL_EAGER_ROWS
                        ? "eager"
                        : "lazy"
                    }
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
            );
          })}
        </div>
      </div>
      <ConfirmDialog
        confirmText={confirmation?.confirmText ?? "确认"}
        description={confirmation?.description}
        destructive
        disabled={isMutating}
        onCancel={() => setConfirmation(null)}
        onConfirm={() => {
          const pending = confirmation;
          if (!pending) {
            return;
          }
          setConfirmation(null);
          finishMutation(pending.operation, pending.successText);
        }}
        open={confirmation !== null}
        title={confirmation?.title ?? "确认操作"}
      />
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
    onSelectSequence,
    onSelectSequenceMembers,
    onSequenceMutationComplete,
    onDoubleClick,
    onContextMenu,
    onEndReached,
    hasMore = false,
    onSortChange,
    onToggleFavorite,
    onKeyboardSelect,
    onMarqueeSelect,
    onRestoreSettled,
    onScrollTopChange,
    onBackgroundClick,
    showToolbar = true,
    topInset = 0,
    restoreGateReady = true,
    sequences = [],
    sequenceMode = "photos",
    onOpenSequence,
    onOpenSequenceDetails,
    onSequenceModeChange,
    expandedSequence,
    expandedSequenceComplete,
    expandingSequenceId,
    onToggleSequenceExpand,
  }: PhotoGridProps) {
    const { t, i18n } = useTranslation();
    const [internalColumnWidth, setInternalColumnWidth] =
      useState(loadGridColumnWidth);
    const targetColWidth = columnWidth ?? internalColumnWidth;
    const [columnCount, setColumnCount] = useState(4);
    const [containerWidth, setContainerWidth] = useState(0);
    const [isToolbarScrolled, setIsToolbarScrolled] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const observerRef = useRef<ResizeObserver | null>(null);
    const targetColWidthRef = useRef(targetColWidth);
    targetColWidthRef.current = targetColWidth;
    const metricsRef = useRef({
      columnCount: 4,
      width: 0,
    });
    const handleGridScrollTopChange = useCallback(
      (scrollTop: number) => {
        setIsToolbarScrolled((previous) => {
          const next = scrollTop > 4;
          return previous === next ? previous : next;
        });
        onScrollTopChange?.(scrollTop);
      },
      [onScrollTopChange]
    );
    // selectedIds/deletingIds 通过 ref 传递，稳定 renderItem 引用。
    // 移除 deps 中的 Set 依赖 → 选中操作仅触发实际变化卡片的 memo 比较。
    const selectedIdsRef = useRef(selectedIds);
    selectedIdsRef.current = selectedIds;
    const scopedSequences = useMemo(() => {
      const photosById = new Map(photos.map((photo) => [photo.id, photo]));
      return sequences.flatMap((sequence) => {
        const memberIds = scopedSequenceMemberIds(sequence);
        if (memberIds.length === 0) {
          return [];
        }
        const representative =
          (sequence.representativePhotoId != null &&
          memberIds.includes(sequence.representativePhotoId)
            ? sequence.photo
            : undefined) ?? photosById.get(memberIds[0]);
        const scopedRepresentative =
          representative ?? sequence.matchedPhoto;
        if (!scopedRepresentative) {
          return [];
        }
        return [
          {
            ...sequence,
            matchedCount: memberIds.length,
            matchedPhotoIds: memberIds,
            photo: scopedRepresentative,
            representativePhotoId: scopedRepresentative.id,
          },
        ];
      });
    }, [photos, sequences]);
    const collapsibleSequences = useMemo(
      () =>
        scopedSequences.filter(
          (sequence) => scopedSequenceMemberIds(sequence).length >= 2
        ),
      [scopedSequences]
    );
    const sequenceByRepresentative = useMemo(
      () =>
        new Map(
          (sequenceMode === "sequences"
            ? scopedSequences
            : collapsibleSequences
          ).map((sequence) => [sequence.photo.id, sequence])
        ),
      [collapsibleSequences, scopedSequences, sequenceMode]
    );
    const sequenceMemberIds = useMemo(
      () =>
        new Set(
          collapsibleSequences.flatMap((sequence) =>
            scopedSequenceMemberIds(sequence)
          )
        ),
      [collapsibleSequences]
    );
    const displayPhotos = useMemo<DisplayPhoto[]>(() => {
      const trayColumns = Math.max(2, Math.min(columnCount, 6));
      const tray = expandedSequence
        ? createSequenceTray(expandedSequence, containerWidth, trayColumns)
        : null;
      if (sequenceMode === "sequences") {
        const visible = scopedSequences.map((sequence) => sequence.photo);
        if (!(expandedSequence && tray)) {
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
      for (const sequence of collapsibleSequences) {
        if (!visibleIds.has(sequence.photo.id)) {
          visible.push(sequence.photo);
        }
      }
      if (!(expandedSequence && tray)) {
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
    }, [
      photos,
      sequenceMode,
      sequenceMemberIds,
      sequenceByRepresentative,
      scopedSequences,
      collapsibleSequences,
      expandedSequence,
      columnCount,
      containerWidth,
      selectedIds,
    ]);
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
          nextIdx = Math.min(
            keyboardPhotos.length - 1,
            currentIdx + columnCount
          );
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
              completeMembers={expandedSequenceComplete?.members}
              containerWidth={containerWidth}
              getDragIds={getDragIds}
              onDoubleClick={onDoubleClick}
              onSelect={onSelect}
              onSelectSequenceMembers={onSelectSequenceMembers}
              onSequenceMutationComplete={onSequenceMutationComplete}
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
          const memberIds = scopedSequenceMemberIds(sequence);
          return (
            <SequenceCard
              expanded={false}
              expanding={expandingSequenceId === sequence.id}
              isSelected={
                memberIds.length > 0 &&
                memberIds.every((id) => selectedIdsRef.current.has(id))
              }
              onClick={(_id, event) => {
                if (onSelectSequence) {
                  onSelectSequence(memberIds, event);
                } else {
                  onSelect(photo.id, event);
                }
              }}
              onOpen={onOpenSequence}
              onOpenDetails={onOpenSequenceDetails}
              onToggleExpand={onToggleSequenceExpand}
              sequence={sequence}
            />
          );
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
            match={photo.match}
            onClick={onSelect}
            onDoubleClick={onDoubleClick}
            onToggleFavorite={onToggleFavorite}
            path={photo.path}
            searchQuery={searchQuery}
            thumbnailPath={photo.thumbnailPath}
            thumbnailSmallPath={photo.thumbnailSmallPath}
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
        onSelectSequence,
        onSelectSequenceMembers,
        onSequenceMutationComplete,
        onDoubleClick,
        onToggleFavorite,
        searchQuery,
        getDragIds,
        columnCount,
        containerWidth,
        sequenceByRepresentative,
        onOpenSequence,
        onOpenSequenceDetails,
        expandedSequence,
        expandedSequenceComplete,
        expandingSequenceId,
        onToggleSequenceExpand,
        t,
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

    // `displayPhotos` can be temporarily empty while changing presentation
    // modes (for example, before the sequence query resolves). The full-grid
    // skeleton is only for the initial photo query, not for a derived view.
    if (loading && photos.length === 0) {
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
            className={`page-toolbar absolute top-0 right-0 left-0 z-50 flex items-center justify-between border-b px-4 py-2 ${
              isToolbarScrolled ? "is-scrolled" : ""
            }`}
            onClick={(event) => event.stopPropagation()}
          >
            <span className="truncate text-[12px] text-muted-foreground">
              {t("photosCount", {
                count:
                  sequenceMode === "sequences"
                    ? displayPhotos.length.toLocaleString()
                    : photos.length.toLocaleString(),
              })}
              {selectedIds.size > 0 &&
                t("photosSelected", { count: selectedIds.size })}
            </span>
            <div className="flex items-center gap-2">
              {onSequenceModeChange && (
                <div className="flex rounded-md border border-border p-0.5 text-[11px]">
                  <button
                    className={`rounded px-2 py-1 ${sequenceMode === "photos" ? "bg-muted text-foreground" : "text-muted-foreground"}`}
                    onClick={() => onSequenceModeChange("photos")}
                    type="button"
                  >
                    照片
                  </button>
                  <button
                    className={`rounded px-2 py-1 ${sequenceMode === "sequences" ? "bg-muted text-foreground" : "text-muted-foreground"}`}
                    onClick={() => onSequenceModeChange("sequences")}
                    type="button"
                  >
                    序列
                  </button>
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
            onRestoreSettled={onRestoreSettled}
            onScrollTopChange={handleGridScrollTopChange}
            ref={gridRef}
            renderItem={renderItem}
            restoreGateReady={restoreGateReady}
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
    if (
      prevProps.expandedSequenceComplete !== nextProps.expandedSequenceComplete
    ) {
      return false;
    }
    if (prevProps.expandingSequenceId !== nextProps.expandingSequenceId) {
      return false;
    }
    if (prevProps.onToggleSequenceExpand !== nextProps.onToggleSequenceExpand) {
      return false;
    }
    if (
      prevProps.onSequenceMutationComplete !==
      nextProps.onSequenceMutationComplete
    ) {
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
    if (prevProps.restoreGateReady !== nextProps.restoreGateReady) {
      return false;
    }
    if (prevProps.onRestoreSettled !== nextProps.onRestoreSettled) {
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
