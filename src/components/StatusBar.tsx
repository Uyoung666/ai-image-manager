import type { AiStatus } from "@/types/photo";

interface StatusBarProps {
  aiStatus: AiStatus | null;
  selectedCount: number;
  totalPhotos: number;
}

export function StatusBar({ totalPhotos, selectedCount, aiStatus }: StatusBarProps) {
  let aiLabel: string;
  let aiColor: string;

  if (!aiStatus) {
    aiLabel = "AI 未就绪";
    aiColor = "text-foreground-tertiary";
  } else if (aiStatus.isEmbedding) {
    const { processed, total } = aiStatus.embeddingProgress;
    const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
    aiLabel = `AI 索引中 ${pct}%`;
    aiColor = "text-[#ffb224]";
  } else if (aiStatus.indexReady) {
    aiLabel = `AI 就绪 (${aiStatus.vectorCount} 向量)`;
    aiColor = "text-[#46a758]";
  } else {
    aiLabel = "AI 未索引";
    aiColor = "text-foreground-tertiary";
  }

  return (
    <div className="flex h-7 shrink-0 items-center justify-between border-border-subtle border-t bg-[#121214] px-4 text-[11px]">
      <div className="flex items-center gap-3 text-muted-foreground">
        <span>共 {totalPhotos.toLocaleString()} 张</span>
        {selectedCount > 0 && (
          <span className="text-foreground">已选 {selectedCount} 张</span>
        )}
      </div>
      <div className={`flex items-center gap-1.5 ${aiColor}`}>
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
        <span>{aiLabel}</span>
      </div>
    </div>
  );
}
