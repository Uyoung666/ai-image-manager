import { Layers, Play, Timer, X } from "lucide-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { PhotoSequenceDetail } from "@/types/photo-sequence";
import { toLocalMediaUrl } from "@/utils/local-media-url";

interface SequenceDetailPanelProps {
  onClose: () => void;
  onOpenPhoto: (photoId: number) => void;
  onPlay: () => void;
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
  const durationText = duration >= 60_000 ? t("sequenceMinutes", { count: Math.round(duration / 60_000) }) : t("sequenceSeconds", { count: Math.round(duration / 1000) });
  const representative = sequence.members[0];
  return (
    <aside className="photo-detail-panel-shell shrink-0 overflow-hidden" style={{ width }}>
      <div className="glass-surface-heavy flex h-full flex-col border-border border-l">
        <header className="flex items-center justify-between border-border border-b px-4 py-3">
          <div className="flex items-center gap-2">
            {sequence.type === "burst" ? <Layers className="h-4 w-4 text-primary" /> : <Timer className="h-4 w-4 text-primary" />}
            <h3 className="font-semibold text-[14px] text-foreground">{t(sequence.type === "burst" ? "sequenceBurstDetail" : "sequenceTimelapseDetail")}</h3>
          </div>
          <button aria-label={t("sequenceCloseDetail")} className="flex h-6 w-6 items-center justify-center rounded-[4px] text-muted-foreground hover:bg-foreground/5" onClick={onClose} type="button"><X className="h-4 w-4" /></button>
        </header>
        <div className="border-border border-b bg-background p-4">
          {representative?.thumbnailPath && <img alt={representative.filename} className="h-[180px] w-full rounded-[6px] object-contain" src={toLocalMediaUrl(representative.thumbnailPath)} />}
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          <section className="grid grid-cols-2 gap-3 text-[12px]">
            <div><p className="text-muted-foreground">{t("sequenceFrames")}</p><p className="font-medium">{sequence.frameCount}</p></div>
            <div><p className="text-muted-foreground">{t("sequenceDuration")}</p><p className="font-medium">{durationText}</p></div>
            <div className="col-span-2"><p className="text-muted-foreground">{t("dateTaken")}</p><p className="font-medium">{formatDate(sequence.startedAt, i18n.language)} — {formatDate(sequence.endedAt, i18n.language)}</p></div>
            {sequence.cameraModel && <div><p className="text-muted-foreground">相机</p><p className="font-medium">{sequence.cameraModel}</p></div>}
            {sequence.lensModel && <div><p className="text-muted-foreground">镜头</p><p className="font-medium">{sequence.lensModel}</p></div>}
          </section>
          <section><p className="mb-2 text-[11px] text-muted-foreground uppercase tracking-wider">{t("sequenceFramesTitle")}</p><div className="flex gap-2 overflow-x-auto pb-1">{sequence.members.map((photo, index) => <button className={`h-16 w-16 shrink-0 overflow-hidden rounded border ${index === 0 ? "border-primary" : "border-border"}`} key={photo.id} onClick={() => onOpenPhoto(photo.id)} type="button">{photo.thumbnailPath && <img alt={photo.filename} className="h-full w-full object-cover" src={toLocalMediaUrl(photo.thumbnailPath)} />}</button>)}</div></section>
          <div className="flex gap-2"><button className="flex flex-1 items-center justify-center gap-1 rounded bg-primary px-3 py-2 text-sm text-primary-foreground" onClick={onPlay} type="button"><Play className="h-4 w-4" />{t("sequencePlay")}</button><button className="rounded border border-border px-3 py-2 text-sm" onClick={() => representative && onOpenPhoto(representative.id)} type="button">{t("sequenceRepresentative")}</button></div>
        </div>
      </div>
    </aside>
  );
});
