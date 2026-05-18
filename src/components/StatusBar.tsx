import { useTranslation } from "react-i18next";
import type { AiStatus } from "@/types/photo";

interface StatusBarProps {
  aiStatus: AiStatus | null;
  selectedCount: number;
  totalPhotos: number;
}

export function StatusBar({
  totalPhotos,
  selectedCount,
  aiStatus,
}: StatusBarProps) {
  const { t } = useTranslation();
  let aiLabel: string;
  let aiColor: string;

  if (!aiStatus) {
    aiLabel = t("aiNotReady");
    aiColor = "text-foreground-tertiary";
  } else if (aiStatus.isEmbedding) {
    const { processed, total } = aiStatus.embeddingProgress;
    const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
    aiLabel = t("aiIndexingPercent", { pct });
    aiColor = "text-warning";
  } else if (aiStatus.indexReady) {
    aiLabel = t("aiReadyVectors", { count: aiStatus.vectorCount });
    aiColor = "text-success";
  } else {
    aiLabel = t("aiNotIndexed");
    aiColor = "text-foreground-tertiary";
  }

  return (
    <div className="flex h-7 shrink-0 items-center justify-between border-border-subtle border-t bg-secondary px-4 text-[11px]">
      <div className="flex items-center gap-3 text-muted-foreground">
        <span>{t("totalPhotosStatus", { count: totalPhotos.toLocaleString() })}</span>
        {selectedCount > 0 && (
          <span className="text-foreground">
            {t("selectedPhotos", { count: selectedCount })}
          </span>
        )}
      </div>
      <div className={`flex items-center gap-1.5 ${aiColor}`}>
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
        <span>{aiLabel}</span>
      </div>
    </div>
  );
}
