import { Layers, Timer } from "lucide-react";
import { memo } from "react";
import type { PhotoSequence } from "@/types/photo-sequence";
import { toLocalMediaUrl } from "@/utils/local-media-url";

interface SequenceCardProps {
  isSelected: boolean;
  onClick: (id: number, event: React.MouseEvent) => void;
  onOpen: (sequenceId: number) => void;
  sequence: PhotoSequence;
}

export const SequenceCard = memo(function SequenceCard({
  sequence,
  isSelected,
  onClick,
  onOpen,
}: SequenceCardProps) {
  const { photo } = sequence;
  const duration = Math.max(0, sequence.endedAt - sequence.startedAt);
  const durationLabel =
    duration >= 60_000 ? `${Math.round(duration / 60_000)} 分钟` : "";
  return (
    <div
      aria-label={`${sequence.type === "burst" ? "连拍" : "延时"}序列，${sequence.frameCount} 张`}
      aria-selected={isSelected}
      className={`group relative w-full cursor-pointer overflow-hidden rounded-[8px] bg-muted ${isSelected ? "ring-2 ring-primary ring-offset-1 ring-offset-background" : "hover:-translate-y-0.5 hover:shadow-lg"}`}
      data-photo-id={photo.id}
      data-photo-path={photo.path}
      onClick={(event) => onClick(photo.id, event)}
      onDoubleClick={() => onOpen(sequence.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          onOpen(sequence.id);
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
          onOpen(sequence.id);
        }}
        type="button"
      >
        {sequence.type === "burst" ? <Layers size={13} /> : <Timer size={13} />}
        <span>
          {sequence.type === "burst" ? "连拍" : "延时"} · {sequence.frameCount}{" "}
          张{durationLabel ? ` · ${durationLabel}` : ""}
        </span>
      </button>
    </div>
  );
});
