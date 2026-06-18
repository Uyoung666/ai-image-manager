import { Trash2 } from "lucide-react";
import type { ReactNode } from "react";

interface CullSessionCardProps {
  getModeIcon: (mode: string) => ReactNode;
  getModeLabel: (mode: string) => string;
  onClick: () => void;
  onDelete: () => void;
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

export function CullSessionCard({
  getModeIcon,
  getModeLabel,
  onClick,
  onDelete,
  session,
}: CullSessionCardProps) {
  const isCurate = session.mode === "curate";
  const isCompleted = session.status === "completed";
  const minC =
    session.pkMode === "quick" ? 5 : session.pkMode === "fine" ? 12 : 8;
  const recompareBudget =
    session.pkMode === "quick"
      ? 0
      : session.pkMode === "fine"
        ? Math.ceil(session.totalPhotos * 0.3)
        : Math.ceil(session.totalPhotos * 0.15);
  const totalWork =
    session.totalPhotos > 0
      ? Math.max(
          1,
          Math.ceil((session.totalPhotos * minC) / 2) + recompareBudget
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
  const displayProgress = isCompleted
    ? 100
    : isCurate
      ? curateProgress
      : duelProgress;
  const progressTooltip = isCurate
    ? `${session.completedComparisons}/${session.totalPhotos}`
    : `${displayProgress}%`;

  return (
    <button
      className="group relative flex cursor-pointer flex-col rounded-[8px] border border-border bg-secondary p-4 text-left transition-colors hover:border-primary/30 hover:bg-secondary/80"
      onClick={onClick}
    >
      {/* Delete */}
      <div
        className="absolute top-3 right-3 z-10 opacity-0 transition-opacity group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.stopPropagation();
            onDelete();
          }
        }}
        role="button"
        tabIndex={0}
      >
        <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
      </div>

      {/* Mode badge */}
      <div className="mb-3 flex items-center gap-1.5">
        <span className="rounded-[4px] bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
          {getModeIcon(session.mode)}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {getModeLabel(session.mode)}
        </span>
        {session.status === "completed" && (
          <span className="ml-auto rounded-[4px] bg-success/10 px-1.5 py-0.5 font-medium text-[10px] text-success">
            ✓
          </span>
        )}
      </div>

      {/* Name */}
      <h3 className="truncate font-medium text-[14px] text-foreground">
        {session.name}
      </h3>

      {/* Meta */}
      <div className="mt-1.5 text-[11px] text-muted-foreground/70">
        {session.totalPhotos} photos
        {session.mode !== "curate" &&
          session.completedComparisons > 0 &&
          ` · ${session.completedComparisons} PKs`}
        {session.mode === "curate" &&
          session.completedComparisons > 0 &&
          ` · ${session.completedComparisons}/${session.totalPhotos} reviewed`}
      </div>

      {/* Progress bar */}
      {session.status === "active" && (
        <div className="group/progress relative mt-3 h-1 w-full overflow-visible rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all duration-300"
            style={{ width: `${displayProgress}%` }}
          />
          <div className="pointer-events-none absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-[4px] bg-foreground px-2 py-0.5 text-[11px] text-background opacity-0 transition-opacity group-hover/progress:opacity-100">
            {progressTooltip}
          </div>
        </div>
      )}
    </button>
  );
}
