import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HardDrive } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { libraryReliabilityActions } from "@/actions/library-reliability";
import { LibraryIssueList } from "@/components/LibraryIssueList";
import {
  LibraryPathText,
  LibraryRelinkButton,
} from "@/components/LibraryRelinkButton";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { LIBRARY_SOURCE_STATUSES } from "@/types/library-reliability";

export const LIBRARY_HEALTH_QUERY = ["libraryHealth"] as const;

export function LibraryHealthDialog({
  folderId,
  attentionOnly = false,
}: {
  folderId?: number;
  attentionOnly?: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [issueFolder, setIssueFolder] = useState(folderId);
  const issuesRef = useRef<HTMLDivElement>(null);
  const [taskId, setTaskId] = useState<string>();
  const [starting, setStarting] = useState(false);
  const task = useQuery({
    enabled: open && Boolean(taskId),
    queryKey: ["libraryTask", taskId],
    queryFn: () => libraryReliabilityActions.getTask(taskId ?? ""),
    refetchInterval: (query) =>
      query.state.data?.status === "queued" ||
      query.state.data?.status === "running"
        ? 800
        : false,
  });
  const running =
    task.data?.status === "queued" || task.data?.status === "running";
  const health = useQuery({
    enabled: open || attentionOnly,
    queryKey: [...LIBRARY_HEALTH_QUERY, folderId],
    queryFn: () => libraryReliabilityActions.getHealth(folderId),
    refetchInterval: running ? 1000 : false,
  });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: LIBRARY_HEALTH_QUERY });
  };
  useEffect(() => {
    if (
      task.data?.status === "done" ||
      task.data?.status === "cancelled" ||
      task.data?.status === "failed"
    ) {
      queryClient.invalidateQueries({ queryKey: LIBRARY_HEALTH_QUERY });
    }
  }, [queryClient, task.data?.status]);

  async function check(id?: number) {
    setStarting(true);
    try {
      const result = await libraryReliabilityActions.reconcile({
        folderId: id,
      });
      setTaskId(result.taskId);
    } catch {
      toast.error(t("libraryReliability.error"));
    } finally {
      setStarting(false);
    }
  }

  async function cancel() {
    if (taskId) {
      try {
        await libraryReliabilityActions.cancelTask(taskId);
        await task.refetch();
        refresh();
      } catch {
        toast.error(t("libraryReliability.error"));
      }
    }
  }

  const hasAttention = Boolean(health.data?.attentionCount);
  if (attentionOnly && !open && !hasAttention) {
    return null;
  }

  const triggerLabel = attentionOnly
    ? t("libraryReliability.attention", {
        count: health.data?.attentionCount ?? 0,
      })
    : t("libraryReliability.title");

  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next);
        setIssueFolder(folderId);
      }}
      open={open}
    >
      <Tooltip disabled={open}>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <Button
              aria-label={triggerLabel}
              className={
                attentionOnly
                  ? "relative shrink-0 border-warning/30 bg-warning/10 text-warning hover:bg-warning/20 hover:text-warning"
                  : "shrink-0"
              }
              size={attentionOnly ? "icon-lg" : "icon-sm"}
              variant="outline"
            >
              <HardDrive aria-hidden="true" />
              {attentionOnly && (
                <span
                  aria-hidden="true"
                  className="absolute top-1 right-1 size-1.5 rounded-full bg-warning ring-2 ring-background"
                />
              )}
            </Button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent>{triggerLabel}</TooltipContent>
      </Tooltip>
      <DialogContent className="grid-cols-[minmax(0,1fr)]" size="xl">
        <DialogHeader className="min-w-0 max-w-full">
          <DialogTitle>{t("libraryReliability.title")}</DialogTitle>
          <DialogDescription>
            {t("libraryReliability.description")}
          </DialogDescription>
        </DialogHeader>
        {health.isPending && <p role="status">{t("loading")}</p>}
        {health.isError && (
          <p className="text-destructive" role="alert">
            {t("libraryReliability.error")}
          </p>
        )}
        {health.data && (
          <>
            <div className="flex min-w-0 max-w-full flex-wrap items-center justify-between gap-2 text-sm">
              <p>{t("libraryReliability.total", health.data)}</p>
              <Button
                disabled={running || starting}
                onClick={() => check(folderId)}
                size="sm"
              >
                {t("libraryReliability.check")}
              </Button>
            </div>
            <dl className="grid min-w-0 max-w-full grid-cols-2 gap-1 text-xs sm:grid-cols-3">
              {LIBRARY_SOURCE_STATUSES.map((status) => (
                <div
                  className="flex min-w-0 items-center justify-between gap-1 rounded bg-muted p-2"
                  key={status}
                >
                  <dt className="min-w-0 break-words">
                    {t(`libraryReliability.status.${status}`)}
                  </dt>
                  <dd className="shrink-0 tabular-nums">
                    {health.data.counts[status] ?? 0}
                  </dd>
                </div>
              ))}
              <div className="flex min-w-0 items-center justify-between gap-1 rounded bg-muted p-2">
                <dt>{t("libraryReliability.status.pending")}</dt>
                <dd className="shrink-0 tabular-nums">{health.data.pending}</dd>
              </div>
              <div className="flex min-w-0 items-center justify-between gap-1 rounded bg-muted p-2">
                <dt>{t("libraryReliability.status.failed")}</dt>
                <dd className="shrink-0 tabular-nums">{health.data.failed}</dd>
              </div>
            </dl>
            <div className="min-w-0 max-w-full" ref={issuesRef}>
              <LibraryIssueList
                folderId={issueFolder}
                key={issueFolder}
                onBack={() => setIssueFolder(folderId)}
                showBack={issueFolder !== folderId}
              />
            </div>
            {health.data.folders.length === 0 && (
              <p className="text-muted-foreground">
                {t("libraryReliability.empty")}
              </p>
            )}
            <ul className="min-w-0 space-y-2 text-xs">
              {health.data.folders.map((folder) => (
                <li
                  className="min-w-0 space-y-2 rounded-md border border-border p-2"
                  key={folder.id}
                >
                  <p className="break-all font-medium">{folder.displayName}</p>
                  <LibraryPathText path={folder.path} />
                  <p className="text-muted-foreground">
                    {t(`libraryReliability.status.${folder.sourceStatus}`)}
                    {" · "}
                    {t("libraryReliability.total", folder)}
                    {folder.lastScanResult &&
                      ` · ${t(`libraryReliability.scanStatus.${folder.lastScanResult}`)}`}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      disabled={running || starting}
                      onClick={() => check(folder.id)}
                      size="sm"
                      variant="outline"
                    >
                      {t("libraryReliability.check")}
                    </Button>
                    <Button
                      onClick={() => {
                        setIssueFolder(folder.id);
                        issuesRef.current?.scrollIntoView({ block: "start" });
                      }}
                      size="sm"
                      variant="outline"
                    >
                      {t("libraryReliability.viewIssues")}
                    </Button>
                    <LibraryRelinkButton
                      onApplied={refresh}
                      target={{ folderId: folder.id }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
        {task.isError && (
          <p className="text-destructive" role="alert">
            {t("libraryReliability.error")}
          </p>
        )}
        {task.data && (
          <section className="min-w-0 space-y-1 text-xs">
            <p role="status">
              {t("libraryReliability.progress", {
                ...task.data,
                status: t(`libraryReliability.taskStatus.${task.data.status}`),
              })}
            </p>
            {task.data.errors.length > 0 && (
              <p className="text-destructive" role="alert">
                {t("libraryReliability.error")}
              </p>
            )}
            {running && (
              <Button onClick={cancel} size="sm" variant="outline">
                {t("cancel")}
              </Button>
            )}
          </section>
        )}
      </DialogContent>
    </Dialog>
  );
}
