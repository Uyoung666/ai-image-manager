import { ArrowRight, MoreHorizontal } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { CullArchiveButton } from "@/components/CullArchiveButton";
import { Copy } from "@/components/icons/copy";
import { FolderOpen } from "@/components/icons/folder-open";
import { IconMotionTrigger } from "@/components/icons/icon-motion";
import { Pencil } from "@/components/icons/pencil";
import { Swords } from "@/components/icons/swords";
import { Trash2 } from "@/components/icons/trash-2";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { CullTaskStage, CullTaskSummary } from "@/types/cull";

export interface CullTaskCardAction {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}

function StageSummary({
  stage,
  task,
}: {
  stage: CullTaskStage;
  task: CullTaskSummary;
}) {
  const { t } = useTranslation();
  const ended = stage.status === "completed";
  let status = t(
    ended ? "cullProject.task.ended" : "cullProject.task.inProgress"
  );
  if (stage.status === "not-started") {
    status = t("cullProject.task.notStarted");
    if (task.workflow === "hybrid" && task.stages[0]?.status === "completed") {
      status = t(
        task.keptCount < 2
          ? "cullProject.task.resultsReady"
          : "cullProject.task.waitingPk"
      );
    }
  }
  return (
    <span className="flex min-w-0 flex-wrap justify-between gap-x-2 gap-y-1 text-xs">
      <span className="text-foreground">
        {t(
          stage.mode === "curate"
            ? "cullProject.curateTab"
            : "cullProject.duelTab"
        )}
        {stage.round
          ? ` · ${t("cullProject.roundNumber", { number: stage.round })}`
          : ""}
        {` · ${status}`}
      </span>
      <span className="text-muted-foreground">
        {stage.mode === "curate"
          ? t("cullReviewedProgress", {
              done: stage.processedCount,
              total: stage.totalPhotos,
            })
          : t("cullProject.task.comparisons", { count: stage.comparisons })}
      </span>
    </span>
  );
}

function TaskWarnings({ task }: { task: CullTaskSummary }) {
  const { t } = useTranslation();
  const sourceWarning =
    task.sourceStatus && task.sourceStatus !== "online"
      ? t(
          task.sourceStatus === "offline"
            ? "shootingProject.sourceOffline"
            : "shootingProject.sourceInaccessible"
        )
      : null;
  const scanWarning =
    task.scanStatus === "failed" || task.scanStatus === "interrupted"
      ? t("cullProject.task.scanWarning")
      : null;
  const preparing =
    task.scanStatus === "pending" || task.scanStatus === "running";
  const warning = [sourceWarning, scanWarning].filter(Boolean).join(" · ");

  return (
    <>
      {preparing && (
        <span className="text-muted-foreground text-xs">
          {t("cullProject.task.preparing")}
        </span>
      )}
      {warning && (
        <span
          className="break-words text-destructive text-xs"
          data-testid="cull-task-warning"
        >
          {warning}
        </span>
      )}
    </>
  );
}

export function CullTaskCard({
  task,
  onOpen,
  onRename,
  onDelete,
  onDuplicate,
}: {
  task: CullTaskSummary;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
  onDuplicate?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const actions: CullTaskCardAction[] = [
    {
      label: t("rename"),
      icon: <Pencil className="h-4 w-4" />,
      onClick: onRename,
    },
    ...(onDuplicate
      ? [
          {
            label: t("duplicate"),
            icon: <Copy className="h-4 w-4" />,
            onClick: onDuplicate,
          },
        ]
      : []),
    {
      label: t("delete"),
      icon: <Trash2 className="h-4 w-4" />,
      onClick: onDelete,
    },
  ];
  const stage =
    task.stages.findLast((item) => item.status !== "not-started") ??
    task.stages[0];
  const progress = stage?.progress ?? 0;
  const date = new Intl.DateTimeFormat(i18n?.resolvedLanguage ?? "en", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(task.createdAt);
  const canViewResults =
    stage?.status === "completed" ||
    (task.workflow === "hybrid" &&
      task.stages[0]?.status === "completed" &&
      task.keptCount < 2);
  const Icon = task.kind === "project" ? FolderOpen : Swords;
  return (
    <TooltipProvider>
      <article
        className="relative flex min-h-[208px] min-w-0 flex-col rounded-lg border border-border bg-secondary transition-colors hover:border-primary/30"
        data-project-id={task.kind === "project" ? task.id : undefined}
        data-task-key={`${task.kind}:${task.id}`}
        data-testid={
          task.kind === "project"
            ? "shooting-project-card"
            : "cull-library-card"
        }
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <IconMotionTrigger asChild>
              <button
                aria-label={t("cullProject.archive.openTask", {
                  name: task.name,
                })}
                className="flex h-full min-h-[208px] w-full min-w-0 flex-1 flex-col gap-2 rounded-lg p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={onOpen}
                type="button"
              >
                <span className="line-clamp-2 min-h-10 w-full break-words pr-16 font-medium text-foreground text-sm [overflow-wrap:anywhere]">
                  {task.name}
                </span>
                <span className="flex w-full min-w-0 items-start gap-1.5 text-muted-foreground text-xs">
                  <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 break-words">
                    {t(
                      task.kind === "project"
                        ? "cullProject.folderSource"
                        : "cullProject.fromLibrary"
                    )}{" "}
                    · {t(`cullProject.workflow_${task.workflow}`)}
                  </span>
                </span>
                <span className="text-muted-foreground text-xs">
                  {t("cullProject.task.counts", {
                    count: task.photoCount,
                    kept: task.keptCount,
                  })}
                </span>
                <span className="flex w-full min-w-0 flex-col gap-1.5">
                  {task.photoCount > 0 ? (
                    task.stages.map((item) => (
                      <StageSummary key={item.mode} stage={item} task={task} />
                    ))
                  ) : (
                    <span className="text-muted-foreground text-xs">
                      {t("cullProject.task.noPhotos")}
                    </span>
                  )}
                  <TaskWarnings task={task} />
                  {task.outputStatus && (
                    <span
                      className="text-muted-foreground text-xs"
                      data-testid="cull-task-output-status"
                    >
                      {t("cullProject.outputTasks")} ·{" "}
                      {t(`shootingProject.outputStatus_${task.outputStatus}`)}
                    </span>
                  )}
                  {task.photoCount > 0 && stage && (
                    <>
                      {stage.mode === "duel" && stage.status === "active" && (
                        <span className="text-muted-foreground text-xs">
                          {t("cullProject.task.estimated", {
                            percent: progress,
                          })}
                        </span>
                      )}
                      <span
                        aria-label={t("cullProject.task.progress")}
                        aria-valuemax={100}
                        aria-valuemin={0}
                        aria-valuenow={progress}
                        aria-valuetext={t(
                          stage.mode === "duel" && stage.status === "active"
                            ? "cullProject.task.estimated"
                            : "cullProject.task.percent",
                          { percent: progress }
                        )}
                        className="block h-1 w-full overflow-hidden rounded-full bg-muted"
                        role="progressbar"
                      >
                        <span
                          className="block h-full rounded-full bg-primary transition-all duration-300"
                          style={{ width: `${progress}%` }}
                        />
                      </span>
                    </>
                  )}
                </span>
                <span className="mt-auto flex w-full min-w-0 flex-wrap items-center justify-between gap-2 pt-2 text-muted-foreground text-xs">
                  <span>{t("cullProject.task.created", { date })}</span>
                  <span className="inline-flex items-center gap-1 text-primary">
                    {t(
                      canViewResults
                        ? "cullProject.task.openResults"
                        : "cullProject.task.continue"
                    )}
                    <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
                  </span>
                </span>
              </button>
            </IconMotionTrigger>
          </TooltipTrigger>
          <TooltipContent className="max-w-[calc(100dvw-2rem)] break-words">
            {task.name}
          </TooltipContent>
        </Tooltip>
        <div className="absolute top-2 right-2 flex items-center gap-1">
          <CullArchiveButton task={task} />
          <Popover onOpenChange={setMenuOpen} open={menuOpen}>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button
                    aria-label={t("cullProject.archive.moreTaskActions")}
                    size="icon"
                    variant="ghost"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>
                {t("cullProject.archive.moreTaskActions")}
              </TooltipContent>
            </Tooltip>
            <PopoverContent
              align="end"
              className="max-h-[var(--radix-popover-content-available-height)] w-44 max-w-[calc(100dvw-1rem)] overflow-y-auto p-1"
            >
              {actions.map((action) => (
                <Button
                  className="h-auto min-h-8 w-full justify-start whitespace-normal text-left"
                  key={action.label}
                  onClick={() => {
                    setMenuOpen(false);
                    action.onClick();
                  }}
                  variant={
                    action.label === t("delete") ? "destructive" : "ghost"
                  }
                >
                  {action.icon}
                  {action.label}
                </Button>
              ))}
            </PopoverContent>
          </Popover>
        </div>
      </article>
    </TooltipProvider>
  );
}
