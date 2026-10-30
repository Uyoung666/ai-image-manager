import { Library, Square } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { openFolderDialog } from "@/actions/shell";
import { shootingProjectActions } from "@/actions/shooting-projects";
import { Copy } from "@/components/icons/copy";
import { FolderOpen } from "@/components/icons/folder-open";
import { IconMotionTrigger } from "@/components/icons/icon-motion";
import { RefreshCw } from "@/components/icons/refresh-cw";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useShootingProjectOutputs } from "@/hooks/use-shooting-project-outputs";
import type {
  ShootingProjectOutputInspection,
  ShootingProjectOutputTask,
} from "@/types/shooting-project";
import { ShootingProjectLibraryDialog } from "./ShootingProjectLibraryDialog";
import {
  shootingProjectBytes,
  shootingProjectErrorKey,
} from "./ShootingProjectStatus";

export function ShootingProjectOutputDialog({
  projectId,
  photoIds,
  onClose,
  onCreated,
}: {
  projectId: string;
  photoIds?: string[];
  onClose: () => void;
  onCreated: (task: ShootingProjectOutputTask) => void;
}) {
  const { t } = useTranslation();
  const [inspection, setInspection] =
    useState<ShootingProjectOutputInspection | null>(null);
  const [targetParent, setTargetParent] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  async function choose() {
    setBusy(true);
    setErrorKey(null);
    try {
      const { path } = await openFolderDialog();
      if (!path) {
        return;
      }
      setInspection(null);
      setAcknowledged(false);
      setTargetParent(path);
      setInspection(
        await shootingProjectActions.inspectOutput({
          projectId,
          targetParent: path,
          photoIds,
        })
      );
    } catch (error) {
      setErrorKey(shootingProjectErrorKey(error));
    } finally {
      setBusy(false);
    }
  }
  async function create() {
    if (!inspection || busy) {
      return;
    }
    setBusy(true);
    setErrorKey(null);
    try {
      const task = await shootingProjectActions.createOutput({
        projectId,
        targetParent,
        photoIds,
        acknowledgeWatchedTarget: acknowledged,
      });
      onCreated(task);
      onClose();
    } catch (error) {
      const key = shootingProjectErrorKey(error);
      setErrorKey(key);
      if (key === "shootingProject.outputWatchRequired") {
        setInspection({ ...inspection, watched: true });
        setAcknowledged(false);
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog onOpenChange={(open) => !(open || busy) && onClose()} open>
      <DialogContent data-testid="shooting-output-dialog" size="lg">
        <DialogHeader>
          <DialogTitle>
            {t(
              photoIds
                ? "shootingProject.copySelected"
                : "shootingProject.copyKept"
            )}
          </DialogTitle>
          <DialogDescription>
            {t("shootingProject.outputDescription")}
          </DialogDescription>
        </DialogHeader>
        <IconMotionTrigger asChild disabled={busy}>
          <Button
            data-testid="shooting-output-choose"
            disabled={busy}
            onClick={choose}
            type="button"
            variant="outline"
          >
            <FolderOpen />
            {t("shootingProject.chooseOutput")}
          </Button>
        </IconMotionTrigger>
        {inspection && (
          <div className="min-w-0 space-y-3">
            <p className="break-all text-xs">{inspection.targetRoot}</p>
            <p className="text-xs" data-testid="shooting-output-counts">
              {t("shootingProject.outputPhotoCounts", {
                originals: inspection.originalCount ?? inspection.count,
                xmp: inspection.xmpCount ?? 0,
              })}
            </p>
            <p className="text-xs">
              {t("shootingProject.outputRange", {
                count: inspection.count,
                size: shootingProjectBytes(inspection.bytes),
                unavailable: inspection.unavailable,
              })}
            </p>
            <p className="text-muted-foreground text-xs leading-relaxed">
              {t("shootingProject.outputXmp")}
            </p>
            {inspection.watched && (
              <div className="space-y-2 rounded-md border border-border bg-muted/50 p-3 text-xs">
                <p>{t("shootingProject.outputWatchWarning")}</p>
                <label className="flex items-start gap-2">
                  <input
                    checked={acknowledged}
                    className="mt-0.5 shrink-0 accent-primary"
                    data-testid="shooting-output-watch-ack"
                    disabled={busy}
                    onChange={(event) => setAcknowledged(event.target.checked)}
                    type="checkbox"
                  />
                  <span>{t("shootingProject.outputWatchAcknowledge")}</span>
                </label>
              </div>
            )}
          </div>
        )}
        {errorKey && (
          <p className="break-words text-destructive text-xs" role="alert">
            {t(errorKey)}
          </p>
        )}
        <DialogFooter>
          <Button
            disabled={busy}
            onClick={onClose}
            type="button"
            variant="outline"
          >
            {t("cancel")}
          </Button>
          <Button
            data-testid="shooting-output-confirm"
            disabled={
              busy ||
              !inspection ||
              inspection.count === 0 ||
              (inspection.watched && !acknowledged)
            }
            onClick={create}
            type="button"
          >
            {t(busy ? "shootingProject.saving" : "shootingProject.startCopy")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const ACTIVE_OUTPUT_STATUSES = new Set(["pending", "running"]);

export function ShootingProjectOutputs({
  controller,
  projectId,
  keptCount,
  selectedIds,
}: {
  projectId: string;
  keptCount: number;
  selectedIds: string[];
  controller?: ReturnType<typeof useShootingProjectOutputs>;
}) {
  const { t } = useTranslation();
  const [outputIds, setOutputIds] = useState<string[] | undefined | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const localController = useShootingProjectOutputs(projectId, !controller);
  const {
    tasks,
    errorKey,
    setErrorKey,
    busyTask,
    watchRetry,
    setWatchRetry,
    load,
    updateTask,
    retry,
    cancel,
    openOutput,
  } = controller ?? localController;
  return (
    <section
      className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-3 sm:p-4"
      data-testid="shooting-output-panel"
    >
      <h2 className="font-medium text-sm">{t("shootingProject.handoff")}</h2>
      <div className="flex min-w-0 flex-wrap gap-2">
        <IconMotionTrigger asChild disabled={keptCount === 0}>
          <Button
            className="h-auto min-h-8 max-w-full whitespace-normal"
            data-testid="shooting-output"
            disabled={keptCount === 0}
            onClick={() => setOutputIds(undefined)}
            type="button"
          >
            <Copy />
            {t("shootingProject.copyKept")}
          </Button>
        </IconMotionTrigger>
        <Button
          className="h-auto min-h-8 max-w-full whitespace-normal"
          data-testid="shooting-output-selected"
          disabled={!selectedIds.length}
          onClick={() => setOutputIds([...selectedIds])}
          type="button"
          variant="outline"
        >
          {t("shootingProject.copySelected")}
        </Button>
        <Button
          className="h-auto min-h-8 max-w-full whitespace-normal"
          data-testid="shooting-add-library"
          disabled={
            keptCount === 0 &&
            !tasks.some((task) => task.status === "completed")
          }
          onClick={() => setLibraryOpen(true)}
          type="button"
          variant="outline"
        >
          <Library />
          {t("shootingProject.addToLibrary")}
        </Button>
      </div>
      {errorKey && (
        <div className="space-y-2">
          <p className="break-words text-destructive text-xs" role="alert">
            {t(errorKey)}
          </p>
          <Button
            onClick={() => {
              setErrorKey(null);
              load();
            }}
            type="button"
            variant="outline"
          >
            {t("retry")}
          </Button>
        </div>
      )}
      {tasks.map((task) => {
        const completed = task.items.filter(
          (item) => item.status === "completed"
        ).length;
        const bytes = task.items.reduce((sum, item) => sum + item.fileSize, 0);
        const copied = task.items.reduce(
          (sum, item) =>
            sum +
            (item.status === "completed" ? item.fileSize : item.copiedBytes),
          0
        );
        return (
          <article
            className="min-w-0 space-y-2 rounded-lg border border-border p-3"
            data-output-id={task.id}
            data-status={task.status}
            data-testid="shooting-output-task"
            key={task.id}
          >
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="break-all text-xs">{task.targetRoot}</p>
                <p className="mt-1 text-muted-foreground text-xs">
                  {t(`shootingProject.outputStatus_${task.status}`)} ·{" "}
                  {t("shootingProject.outputProgress", {
                    done: completed,
                    total: task.items.length,
                  })}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {ACTIVE_OUTPUT_STATUSES.has(task.status) ? (
                  <Button
                    data-testid="shooting-output-cancel"
                    disabled={busyTask === task.id}
                    onClick={() => cancel(task)}
                    type="button"
                    variant="outline"
                  >
                    <Square />
                    {t("cancel")}
                  </Button>
                ) : (
                  <IconMotionTrigger asChild disabled={busyTask === task.id}>
                    <Button
                      data-testid="shooting-output-retry"
                      disabled={busyTask === task.id}
                      onClick={() => retry(task)}
                      type="button"
                      variant="outline"
                    >
                      <RefreshCw />
                      {t(
                        task.status === "interrupted" ||
                          task.status === "cancelled"
                          ? "shootingProject.resumeCopy"
                          : "shootingProject.retryCopy"
                      )}
                    </Button>
                  </IconMotionTrigger>
                )}
                <IconMotionTrigger asChild>
                  <Button
                    data-testid="shooting-output-open"
                    onClick={() => openOutput(task.id)}
                    type="button"
                    variant="outline"
                  >
                    <FolderOpen />
                    {t("shootingProject.openOutput")}
                  </Button>
                </IconMotionTrigger>
              </div>
            </div>
            <progress
              aria-label={t("shootingProject.outputBytesProgress", {
                done: shootingProjectBytes(copied),
                total: shootingProjectBytes(bytes),
              })}
              className="h-1.5 w-full accent-primary"
              max={Math.max(1, bytes)}
              value={Math.min(bytes, copied)}
            />
            <details className="min-w-0 text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                {t("shootingProject.outputManifest")}
              </summary>
              <ul className="mt-2 max-h-44 space-y-2 overflow-y-auto">
                {task.items.map((item) => (
                  <li className="min-w-0" key={item.id}>
                    <p className="break-all">
                      {item.relativePath}
                      {item.kind === "xmp" ? " · XMP" : ""}
                    </p>
                    <p className="break-words text-muted-foreground">
                      {t(`shootingProject.outputItem_${item.status}`)} ·{" "}
                      {shootingProjectBytes(
                        item.status === "completed"
                          ? item.fileSize
                          : item.copiedBytes
                      )}
                      /{shootingProjectBytes(item.fileSize)}
                    </p>
                    {item.error && (
                      <p className="break-words text-destructive">
                        {t(shootingProjectErrorKey({ code: item.error }))}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          </article>
        );
      })}
      {outputIds !== null && (
        <ShootingProjectOutputDialog
          onClose={() => setOutputIds(null)}
          onCreated={(task) => updateTask(task, true)}
          photoIds={outputIds}
          projectId={projectId}
        />
      )}
      {libraryOpen && (
        <ShootingProjectLibraryDialog
          onClose={() => setLibraryOpen(false)}
          photoIds={selectedIds.length ? selectedIds : undefined}
          projectId={projectId}
          tasks={tasks}
        />
      )}
      <Dialog
        onOpenChange={(open) => !(open || busyTask) && setWatchRetry(null)}
        open={watchRetry !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("shootingProject.resumeCopy")}</DialogTitle>
            <DialogDescription>
              {t("shootingProject.outputWatchWarning")}
            </DialogDescription>
          </DialogHeader>
          <p className="break-all text-xs">{watchRetry?.targetRoot}</p>
          <DialogFooter>
            <Button
              disabled={busyTask !== null}
              onClick={() => setWatchRetry(null)}
              type="button"
              variant="outline"
            >
              {t("cancel")}
            </Button>
            <Button
              className="h-auto min-h-8 max-w-full whitespace-normal"
              data-testid="shooting-output-resume-confirm"
              disabled={busyTask !== null}
              onClick={() => watchRetry && retry(watchRetry, true)}
              type="button"
            >
              {t("shootingProject.outputWatchAcknowledge")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
