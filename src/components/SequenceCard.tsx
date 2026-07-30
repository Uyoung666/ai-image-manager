import { ChevronDown, ChevronUp, Layers, Timer } from "lucide-react";
import { memo, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { PhotoSequence } from "@/types/photo-sequence";
import { toLocalMediaUrl } from "@/utils/local-media-url";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

interface SequenceCardProps {
  expanded?: boolean;
  expanding?: boolean;
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
    sequence.matchedCount != null && sequence.matchedCount !== sequence.frameCount
      ? `${sequence.matchedCount}/${sequence.frameCount}`
      : String(sequence.frameCount);
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
      onClick={(event) => {
        cancelPendingClick();
        clickTimerRef.current = setTimeout(() => {
          clickTimerRef.current = null;
          onClick(photo.id, event);
        }, SINGLE_CLICK_DELAY_MS);
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
          loading="lazy"
          src={toLocalMediaUrl(photo.thumbnailPath)}
          height={photo.height ?? 1}
          width={photo.width ?? 1}
        />
      ) : null}
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
