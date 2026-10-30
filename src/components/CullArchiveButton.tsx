import { Archive, ArchiveRestore } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useCullTaskArchive } from "@/hooks/use-cull-task-archive";
import type { CullArchiveTask } from "@/types/cull";

export function CullArchiveButton({
  task,
  onChanged,
}: {
  task: CullArchiveTask;
  onChanged?: () => void;
}) {
  const { t } = useTranslation();
  const { pending, toggle } = useCullTaskArchive();
  const label = t(
    task.archivedAt == null
      ? "cullProject.archive.archive"
      : "cullProject.archive.restore"
  );
  const Icon = task.archivedAt == null ? Archive : ArchiveRestore;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label={label}
            data-testid={`cull-archive-${task.kind}-${task.id}`}
            disabled={pending}
            onClick={(event) => {
              event.stopPropagation();
              toggle(task, onChanged);
            }}
            size="icon"
            variant="ghost"
          >
            <Icon className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
