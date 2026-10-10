import { useTranslation } from "react-i18next";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
  } else if (aiStatus.rebuildRequired) {
    aiLabel = t("aiIndexRebuildRequired");
    aiColor = "text-warning";
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
      className={`glass-surface flex h-7 min-w-0 items-center justify-between gap-3 overflow-hidden border-border-subtle border-t px-3 text-[11px] sm:px-4 ${className ?? ""}`}
      data-surface="statusbar"
    >
      <div className="min-w-0 text-muted-foreground">
        <span className="block truncate">
          {t("totalPhotosStatus", { count: totalPhotos.toLocaleString() })}
        </span>
      </div>
      <div className={`flex min-w-0 items-center gap-1.5 ${aiColor}`}>
        <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
        <Tooltip>
          <TooltipTrigger asChild>
            {/* Truncated status text must remain readable with a keyboard. */}
            <span
              className="truncate"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: truncated status must expose its Tooltip to keyboard users
              tabIndex={0}
            >
              {aiLabel}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {aiStatus?.rebuildRequired
              ? t("aiIndexRebuildSearchPlaceholder")
              : aiLabel}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
