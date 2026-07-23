import { Layers, Play, Timer, X } from "lucide-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
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

export const SequenceDetailPanel = memo(function SequenceDetailPanel({
  sequence,
  width,
  onClose,
  onPlay,
  onOpenPhoto,
  onDeleteManual,
  onRestoreAutomatic,
  onSetRepresentative,
  onSplit,
}: SequenceDetailPanelProps) {
  const { i18n, t } = useTranslation();
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
            <div className="flex gap-2 overflow-x-auto pb-1">
              {sequence.members.map((photo) => (
                <button
                  className={`h-16 w-16 shrink-0 overflow-hidden rounded border ${photo.id === representative?.id ? "border-primary" : "border-border"}`}
                  key={photo.id}
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
              ))}
            </div>
          </section>
          <div className="flex gap-2">
            <button
              className="flex flex-1 items-center justify-center gap-1 rounded bg-primary px-3 py-2 text-primary-foreground text-sm"
              onClick={onPlay}
              type="button"
            >
              <Play className="h-4 w-4" />
              {t("sequencePlay")}
            </button>
            <button
              className="rounded border border-border px-3 py-2 text-sm"
              onClick={() => representative && onOpenPhoto(representative.id)}
              type="button"
            >
              {t("sequenceRepresentative")}
            </button>
          </div>
          {onSetRepresentative && (
            <label className="block text-muted-foreground text-sm">
              代表帧
              <select
                className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-foreground"
                onChange={(event) =>
                  onSetRepresentative(sequence.id, Number(event.target.value))
                }
                value={representative?.id}
              >
                {sequence.members.map((photo) => (
                  <option key={photo.id} value={photo.id}>
                    {photo.filename}
                  </option>
                ))}
              </select>
            </label>
          )}
          {sequence.userLocked && (
            <div className="grid grid-cols-2 gap-2">
              <button
                className="rounded border border-border px-3 py-2 text-sm hover:bg-foreground/5"
                onClick={() => onRestoreAutomatic?.(sequence.id)}
                type="button"
              >
                恢复自动识别
              </button>
              <button
                className="rounded border border-destructive/40 px-3 py-2 text-destructive text-sm hover:bg-destructive/10"
                onClick={() => onDeleteManual?.(sequence.id)}
                type="button"
              >
                删除手动序列
              </button>
            </div>
          )}
          {onSplit && sequence.members.length >= 4 && (
            <div className="flex gap-2">
              <select
                className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm"
                defaultValue={2}
              >
                {sequence.members.slice(1, -1).map((_, index) => (
                  <option key={index + 2} value={index + 2}>
                    从第 {index + 2} 帧拆分
                  </option>
                ))}
              </select>
              <button
                className="rounded border border-border px-3 py-1 text-sm hover:bg-foreground/5"
                onClick={(event) => {
                  const select = event.currentTarget
                    .previousElementSibling as HTMLSelectElement | null;
                  const position = Number(select?.value ?? 2);
                  onSplit(sequence.id, position);
                }}
                type="button"
              >
                拆分
              </button>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
});
