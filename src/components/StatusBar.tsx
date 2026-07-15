import { useTranslation } from "react-i18next";
import type { AiStatus } from "@/types/photo";

interface StatusBarProps {
  aiStatus: AiStatus | null;
  className?: string;
  selectedCount: number;
  totalPhotos: number;
}

export function StatusBar({
  totalPhotos,
  aiStatus,
  className,
}: StatusBarProps) {
  const { t } = useTranslation();
  let aiLabel: string;
  let aiColor: string;

  if (!aiStatus) {
    aiLabel = t("aiNotReady");
    aiColor = "text-foreground-tertiary";
  } else if (aiStatus.lastError) {
    aiLabel =
      aiStatus.lastError.length > 40
        ? `AI 索引失败: ${aiStatus.lastError.slice(0, 40)}…`
        : `AI 索引失败: ${aiStatus.lastError}`;
    aiColor = "text-red-500";
  } else if (aiStatus.isEmbedding) {
    const { processed, total } = aiStatus.embeddingProgress;
    const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
    aiLabel =
      aiStatus.embeddingProgress.phase === "tagging"
        ? t("tagGeneratingProgress", { processed, total })
        : t("aiIndexingPercent", { pct });
    aiColor = "text-warning";
  } else if (aiStatus.indexReady) {
    aiLabel = t("aiReadyVectors", { count: aiStatus.vectorCount });
    aiColor = "text-success";
  } else {
    aiLabel = t("aiNotIndexed");
    aiColor = "text-foreground-tertiary";
  }

  return (
    <div
      className={`glass-surface flex h-7 items-center justify-between border-border-subtle border-t px-4 text-[11px] ${className ?? ""}`}
    >
      <div className="flex items-center gap-3 text-muted-foreground">
        <span>
          {t("totalPhotosStatus", { count: totalPhotos.toLocaleString() })}
        </span>
      </div>
      <div className={`flex items-center gap-1.5 ${aiColor}`}>
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
        <span>{aiLabel}</span>
      </div>
    </div>
  );
}
