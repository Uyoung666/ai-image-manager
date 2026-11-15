import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { libraryReliabilityActions as actions } from "@/actions/library-reliability";
import { LibraryPathText } from "@/components/LibraryPathText";
import { Button } from "@/components/ui/button";
import { LIBRARY_HEALTH_QUERY } from "@/hooks/use-library-change";
import { libraryErrorKey } from "@/utils/library-error";

type Task = Awaited<ReturnType<typeof actions.getTask>>;

export function LibraryTaskPanel({
  task,
  onCancel,
  onDismiss,
}: {
  task: Task;
  onCancel: () => void;
  onDismiss?: () => void;
}) {
  return (
    <TaskContents
      key={task.taskId}
      onCancel={onCancel}
      onDismiss={onDismiss}
      task={task}
    />
  );
}

function TaskContents({
  task,
  onCancel,
  onDismiss,
}: {
  task: Task;
  onCancel: () => void;
  onDismiss?: () => void;
}) {
  const { t } = useTranslation();
  const [offset, setOffset] = useState(0);
  const running = task.status === "queued" || task.status === "running";
  const page = useQuery({
    queryKey: [...LIBRARY_HEALTH_QUERY, "task-errors", task.taskId, offset],
    queryFn: () => actions.getTask(task.taskId, offset),
    enabled: offset > 0,
    refetchInterval: running && offset > 0 ? 800 : false,
  });
  const result = offset > 0 ? page.data : task;
  const errors = result?.errorDetails ?? [];
  return (
    <section
      aria-label={t("libraryReliability.task")}
      className="min-w-0 space-y-2 rounded-md border border-border p-3 text-xs"
      data-surface="card"
    >
      <p role="status">
        {t(`libraryReliability.taskKind.${task.kind}`)} ·{" "}
        {task.updated !== undefined &&
          t("libraryReliability.relinkUpdated", { count: task.updated })}
        {t("libraryReliability.progress", {
          ...task,
          status: t(`libraryReliability.taskStatus.${task.status}`),
        })}
        {running && ` · ${t(`libraryReliability.phase.${task.phase}`)}`}
      </p>
      {running && (
        <progress
          aria-label={t("libraryReliability.task")}
          className="w-full accent-primary"
          max={Math.max(1, task.total)}
          value={task.processed}
        />
      )}
      {[...new Set(task.errors)].slice(0, 3).map((code) => (
        <p className="text-destructive" key={code}>
          {t(libraryErrorKey(code))}
        </p>
      ))}
      {task.errorCount > 0 && (
        <details>
          <summary className="cursor-pointer">
            {t("libraryReliability.errorCount", { count: task.errorCount })}
          </summary>
          {task.errorCount > 0 && (
            <p role="status">
              {t("libraryReliability.errorRange", {
                from: errors.length ? offset + 1 : 0,
                to: errors.length ? offset + errors.length : 0,
                total: task.errorCount,
              })}
            </p>
          )}
          {task.errorCount > task.storedErrorCount && (
            <p>
              {t("libraryReliability.truncatedErrors", {
                count: task.storedErrorCount,
              })}
            </p>
          )}
          {page.isError && offset > 0 && (
            <p role="alert">{t("libraryReliability.error")}</p>
          )}
          {errors.map((item) => (
            <div
              className="min-w-0"
              key={`${item.photoId ?? "task"}-${item.code}-${item.path ?? ""}`}
            >
              <p className="text-destructive">
                {t(libraryErrorKey(item.code))}
              </p>
              {item.path && <LibraryPathText path={item.path} />}
            </div>
          ))}
          {task.storedErrorCount > task.errorLimit && (
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={offset === 0 || page.isFetching}
                onClick={() => setOffset(Math.max(0, offset - task.errorLimit))}
                size="sm"
                variant="outline"
              >
                {t("libraryReliability.previousPage")}
              </Button>
              <Button
                disabled={!result?.hasMoreErrors || page.isFetching}
                onClick={() => setOffset(offset + task.errorLimit)}
                size="sm"
                variant="outline"
              >
                {t("libraryReliability.nextPage")}
              </Button>
            </div>
          )}
        </details>
      )}
      {!running && onDismiss && !task.preview && (
        <Button onClick={onDismiss} size="sm" variant="ghost">
          {t("close")}
        </Button>
      )}
      {running && task.cancellable && (
        <Button onClick={onCancel} size="sm" variant="outline">
          {t("cancel")}
        </Button>
      )}
    </section>
  );
}
