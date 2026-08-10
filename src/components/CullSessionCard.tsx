import { Check, Copy, Pencil, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface CullSessionCardProps {
  getModeIcon: (mode: string) => ReactNode;
  getModeLabel: (mode: string) => string;
  onClick: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onRename: () => void;
  session: {
    id: number;
    name: string;
    mode: string;
    pkMode?: string;
    status: string;
    totalPhotos: number;
    completedComparisons: number;
    createdAt: number;
    completedAt: number | null;
  };
}

function getPkWorkConfig(pkMode?: string) {
  if (pkMode === "quick") {
    return { minComparisons: 5, recompareFactor: 0 };
  }
  if (pkMode === "fine") {
    return { minComparisons: 12, recompareFactor: 0.3 };
  }
  return { minComparisons: 8, recompareFactor: 0.15 };
}

export function CullSessionCard({
  getModeIcon,
  getModeLabel,
  onClick,
  onDelete,
  onDuplicate,
  onRename,
  session,
}: CullSessionCardProps) {
  const { t } = useTranslation();
  const isCurate = session.mode === "curate";
  const isCompleted = session.status === "completed";
  const { minComparisons, recompareFactor } = getPkWorkConfig(session.pkMode);
  const recompareBudget = Math.ceil(session.totalPhotos * recompareFactor);
  const totalWork =
    session.totalPhotos > 0
      ? Math.max(
          1,
          Math.ceil((session.totalPhotos * minComparisons) / 2) +
            recompareBudget
        )
      : 1;
  const duelProgress =
    session.totalPhotos > 0
      ? Math.min(
          99,
          Math.round((session.completedComparisons / totalWork) * 100)
        )
      : 0;
  const curateProgress =
    session.totalPhotos > 0
      ? Math.min(
          99,
          Math.round((session.completedComparisons / session.totalPhotos) * 100)
        )
      : 0;
  // ── 100% guard: when the session is completed, force the bar to
  //     full regardless of formula output.  Prevents the "stuck at
  //     97%" bug when cascade-deleted photos shrink the denominator.
  let displayProgress = duelProgress;
  if (isCompleted) {
    displayProgress = 100;
  } else if (isCurate) {
    displayProgress = curateProgress;
  }
  const progressTooltip = isCurate
    ? `${session.completedComparisons}/${session.totalPhotos}`
    : `${displayProgress}%`;

  return (
    // biome-ignore lint/a11y/useSemanticElements: the card contains nested action buttons
    <div
      className="group relative flex min-w-0 cursor-pointer flex-col rounded-[8px] border border-border bg-secondary p-4 text-left transition-colors hover:border-primary/30 hover:bg-secondary/80"
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) {
          return;
        }
        if (event.key === "Enter") {
          onClick();
        } else if (event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className="absolute top-1.5 right-1.5 z-10 flex opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 max-[760px]:opacity-100">
        {[
          { action: onRename, icon: Pencil, label: t("rename") },
          { action: onDuplicate, icon: Copy, label: t("duplicate") },
          { action: onDelete, icon: Trash2, label: t("delete") },
        ].map(({ action, icon: Icon, label }) => (
          <Tooltip key={label}>
            <TooltipTrigger asChild>
              <button
                aria-label={label}
                className="rounded-[6px] p-2 text-muted-foreground hover:bg-muted hover:text-foreground last:hover:text-destructive"
                onClick={(event) => {
                  event.stopPropagation();
                  action();
                }}
                type="button"
              >
                <Icon className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        ))}
      </div>

      {/* Mode badge */}
      <div className="mb-3 flex min-w-0 items-center gap-1.5 max-[760px]:pr-24">
        <span className="rounded-[4px] bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
          {getModeIcon(session.mode)}
        </span>
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">
          {getModeLabel(session.mode)}
        </span>
      </div>

      {/* Name */}
      <h3 className="truncate font-medium text-[14px] text-foreground">
        {session.name}
      </h3>

      {/* Meta */}
      <div className="mt-1.5 break-words text-[11px] text-muted-foreground/70">
        {t("cullPhotoCount", { count: session.totalPhotos })}
        {session.mode !== "curate" &&
          session.completedComparisons > 0 &&
          ` · ${t("cullPkCount", { count: session.completedComparisons })}`}
        {session.mode === "curate" &&
          session.completedComparisons > 0 &&
          ` · ${t("cullReviewedProgress", { done: session.completedComparisons, total: session.totalPhotos })}`}
      </div>

      {/* Progress bar / completion mark */}
      <div className="mt-3 flex min-h-4 items-center">
        {session.status === "active" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                aria-label={progressTooltip}
                className="relative h-1 w-full overflow-visible rounded-full bg-muted"
                role="img"
              >
                <div
                  className="h-full rounded-full bg-primary transition-all duration-300"
                  style={{ width: `${displayProgress}%` }}
                />
              </div>
            </TooltipTrigger>
            <TooltipContent>{progressTooltip}</TooltipContent>
          </Tooltip>
        )}
        {isCompleted && (
          <span
            aria-hidden="true"
            className="ml-auto flex h-6 w-6 items-center justify-center rounded-[5px] bg-success/10 text-success"
          >
            <Check className="h-3.5 w-3.5" />
          </span>
        )}
      </div>
    </div>
  );
}
