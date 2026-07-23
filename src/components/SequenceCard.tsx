import { Layers, Timer } from "lucide-react";
import { memo, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { PhotoSequence } from "@/types/photo-sequence";
import { toLocalMediaUrl } from "@/utils/local-media-url";

interface SequenceCardProps {
  isSelected: boolean;
  onClick: (id: number, event: React.MouseEvent) => void;
  onOpenDetails: (sequenceId: number) => void;
  onOpen: (sequenceId: number) => void;
  sequence: PhotoSequence;
}

const SINGLE_CLICK_DELAY_MS = 250;

export const SequenceCard = memo(function SequenceCard({
  sequence,
  isSelected,
  onClick,
  onOpenDetails,
  onOpen,
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
  return (
    <div
      aria-label={t("sequenceCardLabel", { count: sequence.frameCount, type: t(sequence.type === "burst" ? "sequenceBurst" : "sequenceTimelapse") })}
      aria-selected={isSelected}
      className={`group relative w-full cursor-pointer overflow-hidden rounded-[8px] bg-muted ${isSelected ? "ring-2 ring-primary ring-offset-1 ring-offset-background" : "hover:-translate-y-0.5 hover:shadow-lg"}`}
      data-photo-id={photo.id}
      data-photo-path={photo.path}
      onClick={(event) => {
        if (event.ctrlKey || event.metaKey) {
          cancelPendingClick();
          onClick(photo.id, event);
        } else {
          cancelPendingClick();
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
        />
      ) : null}
      <div className="pointer-events-none absolute top-2 right-2 flex -space-x-3 opacity-90">
        {[0, 1, 2].map((offset) => (
          <span
            className="h-8 w-6 rounded border border-white/30 bg-white/20 shadow"
            key={offset}
            style={{
              transform: `translate(${offset * -2}px, ${offset * 2}px)`,
            }}
          />
        ))}
      </div>
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
          {t(sequence.type === "burst" ? "sequenceBurst" : "sequenceTimelapse")} · {sequence.frameCount}{" "}
          {t("sequenceFrames")}{durationLabel ? ` · ${durationLabel}` : ""}
        </span>
      </button>
    </div>
  );
});
