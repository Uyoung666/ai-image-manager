// biome-ignore-all lint/style/useFilenamingConvention: React component files use the repository's PascalCase convention.
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  CheckCheck,
  Images,
  Info,
  Play,
  Scissors,
  Square,
  Star,
  Trash2,
  Unlink,
  WandSparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { photoSequenceActions } from "@/actions/photo-sequences";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PhotoCard } from "@/components/PhotoCard";
import { Button } from "@/components/ui/button";
import type { Photo } from "@/types/photo";

export type SequenceWorkspaceScope = "current" | "complete";

export interface SequenceWorkspaceProps {
  completeMembers: readonly Photo[];
  currentMembers: readonly Photo[];
  currentScopeLabel: string;
  onClose: () => void;
  onMutationComplete?: () => void;
  onOpenDetails: (photoId: number, members: readonly Photo[]) => void;
  onPlay: (members: readonly Photo[], startPhotoId?: number) => void;
  onSelectionChange: (photoIds: Set<number>) => void;
  open: boolean;
  selectedPhotoIds: ReadonlySet<number>;
  sequenceId?: number;
}

const CARD_GAP = 12;
const ESTIMATED_ROW_HEIGHT = 196;
const INITIAL_VIEWPORT_HEIGHT = 720;
const INITIAL_VIEWPORT_WIDTH = 1280;
const VIRTUAL_OVERSCAN_ROWS = 2;
const RECOMMENDATION_REASON_LABELS: Record<string, string> = {
  "sequence.representative.reason.analysisFailed": "部分画面无法分析",
  "sequence.representative.reason.balancedExposure": "曝光有效",
  "sequence.representative.reason.favorite": "已收藏",
  "sequence.representative.reason.highRating": "评分较高",
  "sequence.representative.reason.highResolution": "分辨率较高",
  "sequence.representative.reason.manualPreference": "符合人工偏好",
  "sequence.representative.reason.richDetail": "画面信息丰富",
  "sequence.representative.reason.sharp": "画面清晰",
  "sequence.representative.reason.stableFallback": "按序列顺序稳定选择",
};

function getColumnCount(width: number): number {
  if (width >= 1536) {
    return 8;
  }
  if (width >= 1280) {
    return 7;
  }
  if (width >= 1024) {
    return 6;
  }
  if (width >= 768) {
    return 4;
  }
  if (width >= 520) {
    return 3;
  }
  return 2;
}

function observeWorkspaceRect(
  instance: Virtualizer<HTMLDivElement, Element>,
  callback: (rect: { height: number; width: number }) => void
): (() => void) | undefined {
  const element = instance.scrollElement;
  if (!element) {
    return undefined;
  }
  const update = () => {
    callback({
      height: element.clientHeight || INITIAL_VIEWPORT_HEIGHT,
      width: element.clientWidth || INITIAL_VIEWPORT_WIDTH,
    });
  };
  update();
  const observer = new ResizeObserver(update);
  observer.observe(element);
  return () => observer.disconnect();
}

function removeMemberIds(
  selectedPhotoIds: ReadonlySet<number>,
  members: readonly Photo[]
): Set<number> {
  const next = new Set(selectedPhotoIds);
  for (const member of members) {
    next.delete(member.id);
  }
  return next;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the workspace coordinates virtualized selection, scope, and explicit management confirmations in one screen
export function SequenceWorkspace({
  completeMembers,
  currentMembers,
  currentScopeLabel,
  onClose,
  onOpenDetails,
  onPlay,
  onSelectionChange,
  onMutationComplete,
  open,
  selectedPhotoIds,
  sequenceId,
}: SequenceWorkspaceProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scope, setScope] = useState<SequenceWorkspaceScope>("current");
  const [viewportWidth, setViewportWidth] = useState(INITIAL_VIEWPORT_WIDTH);
  const [recommendedPhotoId, setRecommendedPhotoId] = useState<number | null>(
    null
  );
  const [recommendationReasons, setRecommendationReasons] = useState<string[]>(
    []
  );
  const [isMutating, setIsMutating] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    confirmText: string;
    description: string;
    operation: () => Promise<unknown>;
    successText: string;
    title: string;
  } | null>(null);

  useEffect(() => {
    if (open) {
      setScope("current");
      setRecommendedPhotoId(null);
      setRecommendationReasons([]);
    }
  }, [open]);

  useEffect(() => {
    if (!(open && sequenceId)) {
      return;
    }
    let cancelled = false;
    photoSequenceActions
      .recommendRepresentative(
        sequenceId,
        (scope === "current" ? currentMembers : completeMembers).map(
          (photo) => photo.id
        )
      )
      .then((result) => {
        if (!(cancelled || !result)) {
          setRecommendedPhotoId(result.recommendedPhotoId);
          setRecommendationReasons(result.reasonKeys);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRecommendedPhotoId(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [completeMembers, currentMembers, open, scope, sequenceId]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    const updateWidth = () => {
      setViewportWidth(element.clientWidth || INITIAL_VIEWPORT_WIDTH);
    };
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open]);

  const activeMembers = scope === "current" ? currentMembers : completeMembers;
  const columnCount = getColumnCount(viewportWidth);
  const rowCount = Math.ceil(activeMembers.length / columnCount);
  const selectedInScope = useMemo(
    () =>
      activeMembers.reduce(
        (count, photo) => count + (selectedPhotoIds.has(photo.id) ? 1 : 0),
        0
      ),
    [activeMembers, selectedPhotoIds]
  );
  const allSelected =
    activeMembers.length > 0 && selectedInScope === activeMembers.length;
  const selectedActiveIds = useMemo(
    () =>
      activeMembers
        .filter((photo) => selectedPhotoIds.has(photo.id))
        .map((photo) => photo.id),
    [activeMembers, selectedPhotoIds]
  );

  const virtualizer = useVirtualizer({
    count: rowCount,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    getItemKey: (index) =>
      activeMembers[index * columnCount]?.id ?? `sequence-row-${index}`,
    getScrollElement: () => scrollRef.current,
    initialRect: {
      height: INITIAL_VIEWPORT_HEIGHT,
      width: INITIAL_VIEWPORT_WIDTH,
    },
    observeElementRect: observeWorkspaceRect,
    overscan: VIRTUAL_OVERSCAN_ROWS,
  });

  const handleScopeChange = useCallback(
    (nextScope: SequenceWorkspaceScope) => {
      if (nextScope === scope) {
        return;
      }
      onSelectionChange(removeMemberIds(selectedPhotoIds, completeMembers));
      if (scrollRef.current) {
        scrollRef.current.scrollTop = 0;
      }
      setScope(nextScope);
    },
    [completeMembers, onSelectionChange, scope, selectedPhotoIds]
  );

  const handlePhotoClick = useCallback(
    (photoId: number) => {
      const next = new Set(selectedPhotoIds);
      if (next.has(photoId)) {
        next.delete(photoId);
      } else {
        next.add(photoId);
      }
      onSelectionChange(next);
    },
    [onSelectionChange, selectedPhotoIds]
  );

  const handleToggleAll = useCallback(() => {
    const next = new Set(selectedPhotoIds);
    for (const member of activeMembers) {
      if (allSelected) {
        next.delete(member.id);
      } else {
        next.add(member.id);
      }
    }
    onSelectionChange(next);
  }, [activeMembers, allSelected, onSelectionChange, selectedPhotoIds]);

  const runMutation = useCallback(
    async (operation: () => Promise<unknown>, closeAfter = true) => {
      setIsMutating(true);
      try {
        await operation();
        onMutationComplete?.();
        if (closeAfter) {
          onClose();
        }
        return true;
      } catch (error) {
        console.error("[SequenceWorkspace] mutation failed", error);
        toast.error("序列操作失败");
        return false;
      } finally {
        setIsMutating(false);
      }
    },
    [onClose, onMutationComplete]
  );

  const handleSetRepresentative = useCallback(() => {
    if (!(sequenceId && selectedActiveIds.length === 1)) {
      return;
    }
    runMutation(
      () =>
        photoSequenceActions.setRepresentative(
          sequenceId,
          selectedActiveIds[0]
        ),
      false
    ).then((ok) => ok && toast.success("已设为手动代表帧"));
  }, [runMutation, selectedActiveIds, sequenceId]);

  const handleKeepSelected = useCallback(() => {
    if (!(sequenceId && selectedActiveIds.length > 0)) {
      return;
    }
    const deleteCount = activeMembers.length - selectedActiveIds.length;
    if (deleteCount <= 0) {
      return;
    }
    setConfirmation({
      confirmText: "保留并删除其余",
      description: `保留已选 ${selectedActiveIds.length} 张，并将${scope === "complete" ? "完整序列" : currentScopeLabel}内其余 ${deleteCount} 张移到回收站。${scope === "current" && completeMembers.length > activeMembers.length ? "范围外照片不受影响。" : ""}`,
      operation: () =>
        photoSequenceActions.keep(
          sequenceId,
          selectedActiveIds,
          activeMembers.map((photo) => photo.id)
        ),
      successText: `已保留 ${selectedActiveIds.length} 张`,
      title: "确认整理序列",
    });
  }, [
    activeMembers,
    completeMembers.length,
    currentScopeLabel,
    scope,
    selectedActiveIds,
    sequenceId,
  ]);

  const handleRemoveMembers = useCallback(() => {
    if (!(sequenceId && scope === "complete" && selectedActiveIds.length > 0)) {
      return;
    }
    setConfirmation({
      confirmText: "移出序列",
      description: `从序列中移除已选 ${selectedActiveIds.length} 张。照片文件不会被删除；少于 2 张时序列将自动解散。`,
      operation: () =>
        photoSequenceActions.removeMembers(sequenceId, selectedActiveIds),
      successText: "已更新序列成员",
      title: "确认移出序列",
    });
  }, [scope, selectedActiveIds, sequenceId]);

  const handleDissolve = useCallback(() => {
    if (!(sequenceId && scope === "complete")) {
      return;
    }
    setConfirmation({
      confirmText: "解散序列",
      description: `解散这个 ${completeMembers.length} 张照片的序列。照片文件不会被删除。`,
      operation: () => photoSequenceActions.dissolve(sequenceId),
      successText: "序列已解散",
      title: "确认解散序列",
    });
  }, [completeMembers.length, scope, sequenceId]);

  const handleMove = useCallback(
    (direction: -1 | 1) => {
      if (!(sequenceId && selectedActiveIds.length === 1)) {
        return;
      }
      const index = completeMembers.findIndex(
        (photo) => photo.id === selectedActiveIds[0]
      );
      const target = index + direction;
      if (index < 0 || target < 0 || target >= completeMembers.length) {
        return;
      }
      const orderedIds = completeMembers.map((photo) => photo.id);
      [orderedIds[index], orderedIds[target]] = [
        orderedIds[target],
        orderedIds[index],
      ];
      runMutation(
        () => photoSequenceActions.updateMembers(sequenceId, orderedIds),
        true
      ).then((ok) => ok && toast.success("已调整序列顺序"));
    },
    [completeMembers, runMutation, selectedActiveIds, sequenceId]
  );

  const handleSplit = useCallback(() => {
    if (!(sequenceId && selectedActiveIds.length === 1)) {
      return;
    }
    const position = completeMembers.findIndex(
      (photo) => photo.id === selectedActiveIds[0]
    );
    if (position < 2 || position > completeMembers.length - 2) {
      return;
    }
    setConfirmation({
      confirmText: "拆分序列",
      description: `从已选照片前拆分序列，将生成 ${position} 张和 ${completeMembers.length - position} 张两个手动序列。`,
      operation: () => photoSequenceActions.split(sequenceId, position),
      successText: "已拆分序列",
      title: "确认拆分序列",
    });
  }, [completeMembers, selectedActiveIds, sequenceId]);

  if (!open) {
    return null;
  }

  return (
    <section
      aria-label="序列照片工作区"
      className="fixed inset-0 z-50 flex min-h-0 flex-col bg-background"
      data-sequence-workspace=""
    >
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-border border-b bg-background/95 px-4 py-3 backdrop-blur">
        <Button
          aria-label="返回照片流"
          onClick={onClose}
          size="icon-lg"
          variant="ghost"
        >
          <ArrowLeft />
        </Button>

        <div className="mr-auto min-w-0">
          <h2 className="truncate font-semibold text-sm">序列照片</h2>
          <p className="truncate text-muted-foreground text-xs">
            {currentScopeLabel} {currentMembers.length}/完整序列{" "}
            {completeMembers.length} 张
          </p>
        </div>

        <fieldset
          aria-label="序列范围"
          className="flex items-center rounded-md border-0 bg-muted p-0.5"
        >
          <Button
            aria-pressed={scope === "current"}
            onClick={() => handleScopeChange("current")}
            size="sm"
            variant={scope === "current" ? "secondary" : "ghost"}
          >
            {currentScopeLabel}（{currentMembers.length}）
          </Button>
          <Button
            aria-pressed={scope === "complete"}
            onClick={() => handleScopeChange("complete")}
            size="sm"
            variant={scope === "complete" ? "secondary" : "ghost"}
          >
            完整序列（{completeMembers.length}）
          </Button>
        </fieldset>

        <span
          aria-live="polite"
          className="min-w-20 text-right text-muted-foreground text-xs"
        >
          已选 {selectedInScope}/{activeMembers.length}
        </span>

        <Button
          disabled={activeMembers.length === 0}
          onClick={handleToggleAll}
          variant="outline"
        >
          {allSelected ? <Square /> : <CheckCheck />}
          {allSelected
            ? "取消全选"
            : `全选${scope === "complete" ? "完整序列" : currentScopeLabel}`}
        </Button>
        <Button
          disabled={activeMembers.length === 0}
          onClick={() => onPlay(activeMembers)}
        >
          <Play />
          播放
        </Button>
      </header>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-border border-b px-4 py-2">
        {recommendedPhotoId && (
          <span className="mr-auto inline-flex items-center gap-1 text-muted-foreground text-xs">
            <WandSparkles className="size-3.5" />
            推荐代表帧 #{recommendedPhotoId}
            {recommendationReasons.length > 0
              ? ` · ${recommendationReasons
                  .map(
                    (reason) => RECOMMENDATION_REASON_LABELS[reason] ?? reason
                  )
                  .join("、")}`
              : ""}
          </span>
        )}
        <Button
          disabled={isMutating || selectedActiveIds.length !== 1}
          onClick={handleSetRepresentative}
          size="sm"
          variant="outline"
        >
          <Star />
          设为代表帧
        </Button>
        <Button
          disabled={
            isMutating ||
            selectedActiveIds.length === 0 ||
            selectedActiveIds.length === activeMembers.length
          }
          onClick={handleKeepSelected}
          size="sm"
          variant="destructive"
        >
          <Trash2 />
          保留所选，删除其余
        </Button>
        {scope === "complete" && (
          <>
            <Button
              disabled={isMutating || selectedActiveIds.length === 0}
              onClick={handleRemoveMembers}
              size="sm"
              variant="outline"
            >
              <Unlink />
              移出序列
            </Button>
            <Button
              disabled={isMutating || selectedActiveIds.length !== 1}
              onClick={() => handleMove(-1)}
              size="icon-sm"
              title="前移"
              variant="outline"
            >
              <ArrowUp />
            </Button>
            <Button
              disabled={isMutating || selectedActiveIds.length !== 1}
              onClick={() => handleMove(1)}
              size="icon-sm"
              title="后移"
              variant="outline"
            >
              <ArrowDown />
            </Button>
            <Button
              disabled={isMutating || selectedActiveIds.length !== 1}
              onClick={handleSplit}
              size="sm"
              variant="outline"
            >
              <Scissors />
              从此拆分
            </Button>
            <Button
              disabled={isMutating}
              onClick={handleDissolve}
              size="sm"
              variant="outline"
            >
              <Unlink />
              解散序列
            </Button>
          </>
        )}
      </div>
      {scope === "complete" &&
        completeMembers.length > currentMembers.length && (
          <p className="shrink-0 bg-amber-500/10 px-4 py-2 text-amber-700 text-xs dark:text-amber-300">
            当前显示完整序列，包含不在“{currentScopeLabel}
            ”中的照片；本栏结构操作会作用于完整序列。
          </p>
        )}

      <div
        className="min-h-0 flex-1 overflow-auto p-4"
        data-sequence-scroll=""
        ref={scrollRef}
      >
        {activeMembers.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <Images className="size-10 opacity-50" />
            <p className="text-sm">此范围内没有序列照片</p>
          </div>
        ) : (
          <div
            className="relative w-full"
            data-sequence-virtual-grid=""
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const rowStart = virtualRow.index * columnCount;
              const rowMembers = activeMembers.slice(
                rowStart,
                rowStart + columnCount
              );
              return (
                <div
                  className="absolute top-0 left-0 grid w-full"
                  data-sequence-virtual-row={virtualRow.index}
                  key={virtualRow.key}
                  style={{
                    gap: CARD_GAP,
                    gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
                    height: ESTIMATED_ROW_HEIGHT,
                    paddingBottom: CARD_GAP,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {rowMembers.map((photo) => (
                    <div
                      className="relative min-w-0 overflow-hidden"
                      key={photo.id}
                    >
                      {photo.id === recommendedPhotoId && (
                        <span className="absolute top-2 left-2 z-10 rounded bg-primary px-1.5 py-0.5 text-[10px] text-primary-foreground">
                          推荐
                        </span>
                      )}
                      <PhotoCard
                        dominantColors={photo.dominantColors}
                        filename={photo.filename}
                        height={photo.height}
                        id={photo.id}
                        isFavorite={photo.isFavorite}
                        isSelected={selectedPhotoIds.has(photo.id)}
                        onClick={handlePhotoClick}
                        onDoubleClick={(photoId) =>
                          onOpenDetails(photoId, activeMembers)
                        }
                        path={photo.path}
                        thumbnailPath={photo.thumbnailPath}
                        thumbnailSmallPath={photo.thumbnailSmallPath}
                        width={photo.width}
                      />
                      <Button
                        aria-label={`查看 ${photo.filename} 详情`}
                        className="absolute right-2 bottom-2 opacity-0 shadow-sm group-hover:opacity-100"
                        onClick={() => onOpenDetails(photo.id, activeMembers)}
                        size="icon-sm"
                        variant="secondary"
                      >
                        <Info />
                      </Button>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <ConfirmDialog
        confirmText={confirmation?.confirmText ?? "确认"}
        description={confirmation?.description}
        destructive={true}
        disabled={isMutating}
        onCancel={() => setConfirmation(null)}
        onConfirm={() => {
          const pending = confirmation;
          if (!pending) {
            return;
          }
          setConfirmation(null);
          runMutation(pending.operation).then(
            (ok) => ok && toast.success(pending.successText)
          );
        }}
        open={confirmation !== null}
        title={confirmation?.title ?? "确认操作"}
      />
    </section>
  );
}
