// biome-ignore-all lint/a11y/useSemanticElements: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/a11y/noSvgWithoutTitle: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/style/noNestedTernary: scoped component lint cleanup preserves existing UI behavior
import { ChevronDown, ChevronUp, Layers, Timer } from "lucide-react";
import { memo, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { PhotoSequence } from "@/types/photo-sequence";
import { toLocalMediaUrl } from "@/utils/local-media-url";
import { type FaceOverlay, getFaceOverlayStyle } from "./PhotoCard";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

interface SequenceCardProps {
  expanded?: boolean;
  expanding?: boolean;
  faceOverlays?: FaceOverlay[];
  faceOverlaysVisible?: boolean;
  isSelected: boolean;
  onClick: (id: number, event: React.MouseEvent) => void;
  onOpen: (sequenceId: number) => void;
  onOpenDetails: (sequenceId: number) => void;
  onToggleExpand?: (sequenceId: number) => void;
  sequence: PhotoSequence;
}

const SINGLE_CLICK_DELAY_MS = 250;

export const SequenceCard = memo(function SequenceCard({
  sequence,
  isSelected,
  onClick,
  onOpenDetails,
  onOpen,
  onToggleExpand,
  expanded = false,
  expanding = false,
  faceOverlays,
  faceOverlaysVisible = true,
}: SequenceCardProps) {
  const { t } = useTranslation();
  const { photo } = sequence;
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPendingClick = useCallback(() => {
    if (clickTimerRef.current !== null) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
  }, []);
  useEffect(() => cancelPendingClick, [cancelPendingClick]);
  const duration = Math.max(0, sequence.endedAt - sequence.startedAt);
  /* const durationLabel =
    duration >= 60_000 ? `${Math.round(duration / 60_000)} 分钟` : "";
  */
  const durationLabel =
    duration >= 60_000
      ? t("sequenceMinutes", { count: Math.round(duration / 60_000) })
      : "";
  const scopedCount =
    sequence.matchedCount != null &&
    sequence.matchedCount !== sequence.frameCount
      ? `${sequence.matchedCount}/${sequence.frameCount}`
      : String(sequence.frameCount);
  const containerAspect = Math.max(
    0.6,
    Math.min(photo.width / photo.height || 4 / 3, 3)
  );
  return (
    <div
      aria-label={t("sequenceCardLabel", {
        count: sequence.frameCount,
        type: t(
          sequence.type === "burst" ? "sequenceBurst" : "sequenceTimelapse"
        ),
      })}
      aria-pressed={isSelected}
      className={`group relative w-full cursor-pointer overflow-hidden rounded-[8px] bg-muted ${isSelected ? "ring-2 ring-primary ring-offset-1 ring-offset-background" : "hover:-translate-y-0.5 hover:shadow-lg"}`}
      data-photo-id={photo.id}
      data-photo-path={photo.path}
      data-sequence-id={sequence.id}
      onClick={(event) => {
        cancelPendingClick();
        onClick(photo.id, event);
        if (!(event.ctrlKey || event.metaKey)) {
          clickTimerRef.current = setTimeout(() => {
            clickTimerRef.current = null;
            onOpenDetails(sequence.id);
          }, SINGLE_CLICK_DELAY_MS);
        }
      }}
      onDoubleClick={() => {
        cancelPendingClick();
        onOpen(sequence.id);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          onOpenDetails(sequence.id);
        } else if (event.key === " ") {
          event.preventDefault();
          onClick(photo.id, event as unknown as React.MouseEvent);
        }
      }}
      role="button"
      style={{
        aspectRatio: Math.max(
          0.6,
          Math.min(photo.width / photo.height || 4 / 3, 3)
        ),
      }}
      tabIndex={0}
    >
      {photo.thumbnailPath ? (
        <img
          alt={photo.filename}
          className="h-full w-full object-cover"
          height={photo.height ?? 1}
          loading="lazy"
          src={toLocalMediaUrl(photo.thumbnailPath)}
          width={photo.width ?? 1}
        />
      ) : null}
      {faceOverlays?.map((faceOverlay) => (
        <div
          aria-label={faceOverlay.label ?? t("faceReviewTitle")}
          className={`pointer-events-none absolute rounded border-2 border-primary shadow-[0_0_0_1px_rgba(255,255,255,0.5)] transition-opacity duration-200 ${faceOverlaysVisible ? "opacity-100" : "opacity-0"}`}
          key={`${faceOverlay.x}-${faceOverlay.y}-${faceOverlay.width}-${faceOverlay.height}-${faceOverlay.label ?? ""}`}
          role="img"
          style={getFaceOverlayStyle(
            faceOverlay,
            photo.width,
            photo.height,
            containerAspect
          )}
        />
      ))}
      {/* Selection indicator */}
      {isSelected && (
        <div className="absolute top-2 left-2 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-primary ring-1 ring-primary-foreground/20">
          <svg fill="none" height="12" viewBox="0 0 12 12" width="12">
            <path
              d="M2.5 6L5 8.5L9.5 3.5"
              stroke="white"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
            />
          </svg>
        </div>
      )}
      {onToggleExpand && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-label={t(expanded ? "sequenceCollapse" : "sequenceExpand")}
              aria-pressed={expanded}
              className="absolute top-2 right-2 flex h-8 w-8 items-center justify-center rounded-md bg-black/65 text-white shadow backdrop-blur transition-colors hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              disabled={expanding}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                cancelPendingClick();
                onToggleExpand(sequence.id);
              }}
              type="button"
            >
              {expanding ? (
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
              ) : expanded ? (
                <ChevronUp size={17} />
              ) : (
                <ChevronDown size={17} />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {t(expanded ? "sequenceCollapse" : "sequenceExpand")}
          </TooltipContent>
        </Tooltip>
      )}
      <button
        className="absolute right-2 bottom-2 left-2 flex items-center gap-1 rounded bg-black/65 px-2 py-1 text-left text-[11px] text-white backdrop-blur"
        onClick={(event) => {
          event.stopPropagation();
          onOpenDetails(sequence.id);
        }}
        type="button"
      >
        {sequence.type === "burst" ? <Layers size={13} /> : <Timer size={13} />}
        <span>
          {t(sequence.type === "burst" ? "sequenceBurst" : "sequenceTimelapse")}{" "}
          · {scopedCount} {t("sequenceFrames")}
          {durationLabel ? ` · ${durationLabel}` : ""}
        </span>
      </button>
    </div>
  );
});
