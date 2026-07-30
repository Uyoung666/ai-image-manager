// biome-ignore-all lint/style/useFilenamingConvention: React component files use the repository's PascalCase convention.
import {
  ChevronDown,
  Layers,
  Play,
  Timer,
  WandSparkles,
  X,
} from "lucide-react";
import { memo, useEffect, useState, type WheelEvent } from "react";
import { useTranslation } from "react-i18next";
import { photoSequenceActions } from "@/actions/photo-sequences";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import type { PhotoSequenceDetail } from "@/types/photo-sequence";
import { toLocalMediaUrl } from "@/utils/local-media-url";

interface SequenceDetailPanelProps {
  onClose: () => void;
  onDeleteManual?: (id: number) => void;
  onOpenPhoto: (photoId: number) => void;
  onPlay: () => void;
  onRestoreAutomatic?: (id: number) => void;
  onSetRepresentative?: (sequenceId: number, photoId: number) => void;
  onSplit?: (sequenceId: number, position: number) => void;
  sequence: PhotoSequenceDetail | null;
  width: number;
}

function formatDate(value: number, locale: string) {
  return new Date(value).toLocaleString(locale);
}

function handleFrameStripWheel(event: WheelEvent<HTMLDivElement>) {
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
    return;
  }
  event.preventDefault();
  event.currentTarget.scrollLeft += event.deltaY;
}

const REASON_LABELS: Record<string, string> = {
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

function formatReason(reason: string) {
  return REASON_LABELS[reason] ?? reason;
}

export const SequenceDetailPanel = memo(function SequenceDetailPanel({
  sequence,
  width,
  onClose,
  onPlay,
  onOpenPhoto,
  onRestoreAutomatic,
  onSetRepresentative,
  onSplit,
}: SequenceDetailPanelProps) {
  const { i18n, t } = useTranslation();
  const [splitPosition, setSplitPosition] = useState(2);
  const [recommendation, setRecommendation] = useState<{
    photoId: number;
    reasons: string[];
  } | null>(null);
  const [recommendationLoading, setRecommendationLoading] = useState(false);
  useEffect(() => {
    if (!sequence) {
      setRecommendation(null);
      setRecommendationLoading(false);
      return;
    }
    let cancelled = false;
    setRecommendation(null);
    setRecommendationLoading(true);
    photoSequenceActions
      .recommendRepresentative(
        sequence.id,
        sequence.members.map((photo) => photo.id)
      )
      .then((result) => {
        if (!(cancelled || !result)) {
          setRecommendation({
            photoId: result.recommendedPhotoId,
            reasons: result.reasonKeys,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRecommendation(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setRecommendationLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sequence]);
  if (!sequence) {
    return (
      <aside
        className="photo-detail-panel-shell shrink-0 overflow-hidden"
        style={{ width }}
      >
        <div className="glass-surface-heavy flex h-full items-center justify-center border-border border-l">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
        </div>
      </aside>
    );
  }
  const duration = Math.max(0, sequence.endedAt - sequence.startedAt);
  const durationText =
    duration >= 60_000
      ? t("sequenceMinutes", { count: Math.round(duration / 60_000) })
      : t("sequenceSeconds", { count: Math.round(duration / 1000) });
  const representative =
    sequence.members.find(
      (photo) => photo.id === sequence.representativePhotoId
    ) ?? sequence.members[0];
  const validSplitPosition = Math.min(
    Math.max(2, splitPosition),
    sequence.members.length - 2
  );
  return (
    <aside
      className="photo-detail-panel-shell shrink-0 overflow-hidden"
      style={{ width }}
    >
      <div className="glass-surface-heavy flex h-full flex-col border-border border-l">
        <header className="flex items-center justify-between border-border border-b px-4 py-3">
          <div className="flex items-center gap-2">
            {sequence.type === "burst" ? (
              <Layers className="h-4 w-4 text-primary" />
            ) : (
              <Timer className="h-4 w-4 text-primary" />
            )}
            <h3 className="font-semibold text-[14px] text-foreground">
              {t(
                sequence.type === "burst"
                  ? "sequenceBurstDetail"
                  : "sequenceTimelapseDetail"
              )}
            </h3>
          </div>
          <button
            aria-label={t("sequenceCloseDetail")}
            className="flex h-6 w-6 items-center justify-center rounded-[4px] text-muted-foreground hover:bg-foreground/5"
            onClick={onClose}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="border-border border-b bg-background p-4">
          {representative?.thumbnailPath && (
            <img
              alt={representative.filename}
              className="h-[180px] w-full rounded-[6px] object-contain"
              height={180}
              src={toLocalMediaUrl(representative.thumbnailPath)}
              width={320}
            />
          )}
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          <section className="grid grid-cols-2 gap-3 text-[12px]">
            <div>
              <p className="text-muted-foreground">{t("sequenceFrames")}</p>
              <p className="font-medium">{sequence.frameCount}</p>
            </div>
            <div>
              <p className="text-muted-foreground">{t("sequenceDuration")}</p>
              <p className="font-medium">{durationText}</p>
            </div>
            <div className="col-span-2">
              <p className="text-muted-foreground">{t("dateTaken")}</p>
              <p className="font-medium">
                {formatDate(sequence.startedAt, i18n.language)} —{" "}
                {formatDate(sequence.endedAt, i18n.language)}
              </p>
            </div>
            {sequence.cameraModel && (
              <div>
                <p className="text-muted-foreground">相机</p>
                <p className="font-medium">{sequence.cameraModel}</p>
              </div>
            )}
            {sequence.lensModel && (
              <div>
                <p className="text-muted-foreground">镜头</p>
                <p className="font-medium">{sequence.lensModel}</p>
              </div>
            )}
          </section>
          <section>
            <p className="mb-2 text-[11px] text-muted-foreground uppercase tracking-wider">
              {t("sequenceFramesTitle")}
            </p>
            <div
              className="flex gap-2 overflow-x-auto pb-1"
              onWheel={handleFrameStripWheel}
            >
              {sequence.members.map((photo, index) => (
                <div className="w-16 shrink-0" key={photo.id}>
                  <button
                    aria-label={`打开第 ${index + 1} 帧：${photo.filename}`}
                    className={`h-16 w-16 overflow-hidden rounded border ${photo.id === representative?.id ? "border-primary" : "border-border"}`}
                    onClick={() => onOpenPhoto(photo.id)}
                    type="button"
                  >
                    {photo.thumbnailPath && (
                      <img
                        alt={photo.filename}
                        className="h-full w-full object-cover"
                        height={64}
                        src={toLocalMediaUrl(photo.thumbnailPath)}
                        width={64}
                      />
                    )}
                  </button>
                  <p className="mt-1 text-center text-[10px] text-muted-foreground">
                    第 {index + 1} 帧
                  </p>
                </div>
              ))}
            </div>
          </section>
          {recommendationLoading && (
            <section
              aria-label="正在加载推荐代表帧"
              className="min-h-[106px] rounded-md border border-primary/20 bg-primary/5 p-3"
            >
              <Skeleton className="h-5 w-44" />
              <Skeleton className="mt-2 h-4 w-full" />
              <Skeleton className="mt-3 h-8 w-24" />
            </section>
          )}
          {!recommendationLoading && recommendation && (
            <section className="rounded-md border border-primary/20 bg-primary/5 p-3">
              <p className="flex items-center gap-1 font-medium text-sm">
                <WandSparkles className="size-4 text-primary" />
                推荐第{" "}
                {sequence.members.findIndex(
                  (photo) => photo.id === recommendation.photoId
                ) + 1}{" "}
                帧作为代表帧
              </p>
              <p className="mt-1 text-muted-foreground text-xs">
                依据：{recommendation.reasons.map(formatReason).join("、")}
              </p>
              {onSetRepresentative &&
                recommendation.photoId !== sequence.representativePhotoId && (
                  <Button
                    className="mt-2"
                    onClick={() =>
                      onSetRepresentative(sequence.id, recommendation.photoId)
                    }
                    size="sm"
                  >
                    采用推荐
                  </Button>
                )}
            </section>
          )}
          <div>
            <button
              className="flex w-full items-center justify-center gap-1 rounded bg-primary px-3 py-2 text-primary-foreground text-sm"
              onClick={onPlay}
              type="button"
            >
              <Play className="h-4 w-4" />
              {t("sequencePlay")}
            </button>
          </div>
          {onSetRepresentative && (
            <div className="space-y-1">
              <p className="text-muted-foreground text-sm">选取代表帧</p>
              <Popover>
                <PopoverTrigger asChild>
                  <Button className="w-full justify-between" variant="outline">
                    <span className="truncate">
                      第{" "}
                      {sequence.members.findIndex(
                        (photo) => photo.id === representative?.id
                      ) + 1}{" "}
                      帧 · {representative?.filename}
                    </span>
                    <ChevronDown />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="max-h-64 w-[var(--radix-popover-trigger-width)] overflow-y-auto p-1"
                >
                  {sequence.members.map((photo, index) => (
                    <Button
                      className="w-full justify-start"
                      key={photo.id}
                      onClick={() => onSetRepresentative(sequence.id, photo.id)}
                      variant={
                        photo.id === representative?.id ? "secondary" : "ghost"
                      }
                    >
                      第 {index + 1} 帧 · {photo.filename}
                    </Button>
                  ))}
                </PopoverContent>
              </Popover>
            </div>
          )}
          {onSplit && sequence.members.length >= 4 && (
            <div className="flex gap-2">
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    className="min-w-0 flex-1 justify-between"
                    variant="outline"
                  >
                    <span>从第 {validSplitPosition} 帧开始拆分</span>
                    <ChevronDown />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="max-h-64 w-[var(--radix-popover-trigger-width)] overflow-y-auto p-1"
                >
                  {sequence.members.slice(1, -1).map((photo, index) => (
                    <Button
                      className="w-full justify-start"
                      key={photo.id}
                      onClick={() => setSplitPosition(index + 2)}
                      variant={
                        validSplitPosition === index + 2 ? "secondary" : "ghost"
                      }
                    >
                      从第 {index + 2} 帧开始拆分
                    </Button>
                  ))}
                </PopoverContent>
              </Popover>
              <Button
                onClick={() => onSplit(sequence.id, validSplitPosition)}
                variant="outline"
              >
                确认拆分
              </Button>
            </div>
          )}
          {sequence.userLocked && (
            <div>
              <button
                className="w-full rounded border border-border px-3 py-2 text-sm hover:bg-foreground/5"
                onClick={() => onRestoreAutomatic?.(sequence.id)}
                type="button"
              >
                恢复自动识别
              </button>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
});
