// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/a11y/noStaticElementInteractions: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/a11y/noNoninteractiveElementInteractions: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/style/useFilenamingConvention: React component files use the repository's PascalCase convention.
import { Layers, Play, Timer, WandSparkles, X } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type WheelEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { photoSequenceActions } from "@/actions/photo-sequences";
import { FilterDropdown } from "@/components/filter-dropdown";
import { loadPhotoDetailPanelWidth } from "@/components/PhotoDetailPanel";
import { Button } from "@/components/ui/button";
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
  onWidthChange?: (width: number) => void;
  sequence: PhotoSequenceDetail | null;
  width: number;
}

const PANEL_WIDTH_KEY = "detail_panel_width";
const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH = 480;
const _DEFAULT_PANEL_WIDTH = 300;

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
  "sequence.representative.reason.analysisFailed":
    "representativeReasonAnalysisFailed",
  "sequence.representative.reason.balancedExposure":
    "representativeReasonBalancedExposure",
  "sequence.representative.reason.favorite": "representativeReasonFavorite",
  "sequence.representative.reason.highRating": "representativeReasonHighRating",
  "sequence.representative.reason.highResolution":
    "representativeReasonHighResolution",
  "sequence.representative.reason.manualPreference":
    "representativeReasonManualPreference",
  "sequence.representative.reason.richDetail": "representativeReasonRichDetail",
  "sequence.representative.reason.sharp": "representativeReasonSharp",
  "sequence.representative.reason.stableFallback":
    "representativeReasonStableFallback",
};

function formatReason(
  reason: string,
  t: (k: string, o?: Record<string, unknown>) => string
) {
  return t(REASON_LABELS[reason] ?? reason);
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
  onWidthChange,
}: SequenceDetailPanelProps) {
  const { i18n, t } = useTranslation();
  const [splitPosition, setSplitPosition] = useState(2);
  const [panelWidth, setPanelWidth] = useState(loadPhotoDetailPanelWidth);
  const [resizing, setResizing] = useState(false);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(0);
  const currentWidth = useRef(panelWidth);
  const [recommendation, setRecommendation] = useState<{
    photoId: number;
    reasons: string[];
  } | null>(null);
  const [recommendationLoading, setRecommendationLoading] = useState(false);
  const displayWidth = onWidthChange ? panelWidth : width;

  // Keep ref in sync for resize callback closure
  useEffect(() => {
    currentWidth.current = panelWidth;
    onWidthChange?.(panelWidth);
  }, [onWidthChange, panelWidth]);

  // Resize handling
  useEffect(() => {
    if (!resizing) {
      return;
    }
    function handleMouseMove(e: MouseEvent) {
      const delta = resizeStartX.current - e.clientX;
      const newWidth = Math.max(
        MIN_PANEL_WIDTH,
        Math.min(MAX_PANEL_WIDTH, resizeStartWidth.current + delta)
      );
      currentWidth.current = newWidth;
      setPanelWidth(newWidth);
    }
    function handleMouseUp() {
      setResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        localStorage.setItem(PANEL_WIDTH_KEY, String(currentWidth.current));
      } catch {
        /* ignore */
      }
    }
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [resizing]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setResizing(true);
    resizeStartX.current = e.clientX;
    resizeStartWidth.current = currentWidth.current;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

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
        className="photo-detail-panel-shell h-full shrink-0 overflow-hidden"
        style={{ width: displayWidth }}
      >
        <div
          className="glass-surface-heavy relative flex h-full items-center justify-center border-border border-l"
          data-surface="inspector"
        >
          {onWidthChange && (
            <div
              className={`absolute top-0 -left-0.5 z-10 h-full w-1 cursor-col-resize transition-colors ${
                resizing ? "bg-primary" : "hover:bg-primary/50"
              }`}
              onMouseDown={handleResizeStart}
            />
          )}
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
      className="photo-detail-panel-shell h-full shrink-0 overflow-hidden"
      style={{ width: displayWidth }}
    >
      <div
        className="glass-surface-heavy relative flex h-full flex-col border-border border-l"
        data-surface="inspector"
      >
        {/* Resize handle — drag left edge to resize */}
        {onWidthChange && (
          <div
            className={`absolute top-0 -left-0.5 z-10 h-full w-1 cursor-col-resize transition-colors ${
              resizing ? "bg-primary" : "hover:bg-primary/50"
            }`}
            onMouseDown={handleResizeStart}
          />
        )}
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
        <div
          className="border-border border-b bg-background p-4"
          data-surface="media-well"
        >
          {representative?.thumbnailPath && (
            <img
              alt={representative.filename}
              className="sequence-detail-preview h-[180px] w-full rounded-[6px] object-contain"
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
                <p className="text-muted-foreground">{t("camera")}</p>
                <p className="font-medium">{sequence.cameraModel}</p>
              </div>
            )}
            {sequence.lensModel && (
              <div>
                <p className="text-muted-foreground">{t("lens")}</p>
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
                    aria-label={t("sequenceOpenFrameAria", {
                      frame: index + 1,
                      name: photo.filename,
                    })}
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
                    {t("sequenceFrameLabel", { frame: index + 1 })}
                  </p>
                </div>
              ))}
            </div>
          </section>
          {recommendationLoading && (
            <section
              aria-label={t("sequenceLoadingRecommendationAria")}
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
                {t("sequenceRecommendRepresentative", {
                  frame:
                    sequence.members.findIndex(
                      (photo) => photo.id === recommendation.photoId
                    ) + 1,
                })}
              </p>
              <p className="mt-1 text-muted-foreground text-xs">
                {t("sequenceRecommendBasis", {
                  reasons: recommendation.reasons
                    .map((reason) => formatReason(reason, t))
                    .join(t("sequenceReasonJoin")),
                })}
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
                    {t("sequenceApplyRecommendation")}
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
              <p className="text-muted-foreground text-sm">
                {t("sequenceSetRepresentative")}
              </p>
              <FilterDropdown
                ariaLabel={t("sequenceSetRepresentative")}
                className="w-full min-w-0 truncate"
                onChange={(value) => {
                  const photo = sequence.members.find(
                    (member) => String(member.id) === value
                  );
                  if (photo) {
                    onSetRepresentative(sequence.id, photo.id);
                  }
                }}
                options={sequence.members.map((photo, index) => ({
                  label: t("sequenceFrameWithName", {
                    frame: index + 1,
                    name: photo.filename,
                  }),
                  value: String(photo.id),
                }))}
                placeholder={t("sequenceSetRepresentative")}
                value={String(representative?.id ?? "")}
              />
            </div>
          )}
          {onSplit && sequence.members.length >= 4 && (
            <div className="flex gap-2">
              <div className="min-w-0 flex-1">
                <FilterDropdown
                  ariaLabel={t("sequenceSplitFrom", {
                    frame: validSplitPosition,
                  })}
                  className="w-full"
                  onChange={(value) => setSplitPosition(Number(value))}
                  options={sequence.members.slice(1, -1).map((_, index) => ({
                    label: t("sequenceSplitFrom", { frame: index + 2 }),
                    value: String(index + 2),
                  }))}
                  placeholder={t("sequenceSplitFrom", {
                    frame: validSplitPosition,
                  })}
                  value={String(validSplitPosition)}
                />
              </div>
              <Button
                onClick={() => onSplit(sequence.id, validSplitPosition)}
                variant="outline"
              >
                {t("sequenceConfirmSplit")}
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
                {t("sequenceRestoreAutomatic")}
              </button>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
});
