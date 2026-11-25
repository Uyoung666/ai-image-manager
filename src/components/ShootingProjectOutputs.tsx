import { Library, Square } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
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
  ShootingProjectOutputAmbiguity,
  ShootingProjectOutputDecision,
  ShootingProjectOutputInspection,
  ShootingProjectOutputTask,
} from "@/types/shooting-project";
import { ShootingProjectLibraryDialog } from "./ShootingProjectLibraryDialog";
import {
  shootingProjectBytes,
  shootingProjectErrorKey,
} from "./ShootingProjectStatus";

type SidecarChoice = ShootingProjectOutputDecision["action"];
type OutputPhase = "choosing" | "inspecting" | "creating";
const PATH_PART_SEPARATOR = /[\\/]/;
const SIDECAR_SUFFIX = /\.(?:xmp|acr)$/i;

function relativeFileName(path: string) {
  return path.split(PATH_PART_SEPARATOR).at(-1) ?? path;
}

function SidecarChoiceGroup({
  group,
  choice,
  onChange,
  disabled,
}: {
  group: ShootingProjectOutputAmbiguity;
  choice?: SidecarChoice;
  onChange: (action: SidecarChoice) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  const commonPath = group.files[0].relativePath.replace(SIDECAR_SUFFIX, "");
  const name = relativeFileName(commonPath);
  const folder = commonPath.slice(0, -(name.length + 1));
  const blocked = group.files.some((file) => file.unavailable);
  const photos = [...group.photos].sort(
    (a, b) => Number(b.selected) - Number(a.selected)
  );
  return (
    <fieldset
      aria-describedby={blocked ? `${headingId}-unavailable` : undefined}
      aria-labelledby={folder ? `${headingId} ${headingId}-folder` : headingId}
      className="min-w-0 space-y-2 rounded-md border border-border bg-muted/30 p-2.5"
      disabled={disabled}
    >
      <div className="min-w-0">
        <p className="font-medium [overflow-wrap:anywhere]" id={headingId}>
          {name}
        </p>
        {folder && (
          <p
            className="text-muted-foreground [overflow-wrap:anywhere]"
            id={`${headingId}-folder`}
          >
            {folder}
          </p>
        )}
      </div>
      <ul className="min-w-0 space-y-1">
        {photos.map((photo) => (
          <li
            className="flex min-w-0 flex-wrap items-baseline gap-x-2 [overflow-wrap:anywhere]"
            key={photo.relativePath}
          >
            <span className="font-medium text-muted-foreground">
              {t(
                photo.selected
                  ? "shootingProject.outputPhotoSelected"
                  : "shootingProject.outputPhotoNotSelected"
              )}
            </span>
            <span className="min-w-0">
              {relativeFileName(photo.relativePath)}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground [overflow-wrap:anywhere]">
        {t("shootingProject.outputSidecarFiles", {
          files: group.files
            .map((file) => relativeFileName(file.relativePath))
            .join(" · "),
        })}
      </p>
      {blocked && (
        <p
          className="text-muted-foreground [overflow-wrap:anywhere]"
          id={`${headingId}-unavailable`}
        >
          {t("shootingProject.outputSidecarUnavailable")}
        </p>
      )}
      <div className="flex min-w-0 flex-wrap gap-2">
        {(["include", "skip"] as const).map((action) => (
          <label
            className="flex max-w-full cursor-pointer items-center gap-2 rounded-md border border-border bg-popover px-2 py-1.5 has-disabled:cursor-not-allowed has-checked:border-primary has-checked:bg-primary/5 has-disabled:opacity-60"
            key={action}
          >
            <input
              checked={choice === action}
              className="shrink-0 accent-primary"
              disabled={blocked && action === "include"}
              name={group.id}
              onChange={() => onChange(action)}
              type="radio"
              value={action}
            />
            <span className="min-w-0 break-words">
              {t(
                action === "include"
                  ? "shootingProject.outputIncludeSidecars"
                  : "shootingProject.outputSkipSidecars"
              )}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

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
  const [decisions, setDecisions] = useState(new Map<string, SidecarChoice>());
  const [phase, setPhase] = useState<OutputPhase | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const created = useRef(false);
  const alert = useRef<HTMLDivElement>(null);
  const focusAfterFailure = useRef(false);
  const busy = phase !== null;
  const refreshed =
    errorKey === "shootingProject.outputInspectionChanged" ||
    errorKey === "shootingProject.outputInspectionExpired";
  const groups = inspection?.ambiguities ?? [];
  const remaining = groups.length - decisions.size;
  const included = groups
    .filter((group) => decisions.get(group.id) === "include")
    .flatMap((group) => group.files);
  useEffect(() => {
    if (!busy && focusAfterFailure.current) {
      focusAfterFailure.current = false;
      alert.current?.focus();
    }
  }, [busy]);

  async function inspect(path: string) {
    setPhase("inspecting");
    setInspection(null);
    setDecisions(new Map());
    setAcknowledged(false);
    setTargetParent(path);
    setInspection(
      await shootingProjectActions.inspectOutput({
        projectId,
        targetParent: path,
        photoIds,
      })
    );
  }
  async function choose() {
    setPhase("choosing");
    setErrorKey(null);
    try {
      const { path } = await openFolderDialog();
      if (!path) {
        return;
      }
      await inspect(path);
    } catch (error) {
      setErrorKey(shootingProjectErrorKey(error));
    } finally {
      setPhase(null);
    }
  }
  async function create() {
    if (!inspection || busy || remaining > 0) {
      return;
    }
    setPhase("creating");
    setErrorKey(null);
    try {
      const task = await shootingProjectActions.createOutput({
        projectId,
        targetParent,
        photoIds,
        inspectionToken: inspection.token,
        decisions: Array.from(decisions, ([id, action]) => ({ id, action })),
        acknowledgeWatchedTarget: acknowledged,
      });
      created.current = true;
      onCreated(task);
      onClose();
    } catch (error) {
      const key = shootingProjectErrorKey(error);
      focusAfterFailure.current = true;
      setErrorKey(key);
      if (key === "shootingProject.outputWatchRequired") {
        setInspection({ ...inspection, watched: true });
        setAcknowledged(false);
      } else if (
        key === "shootingProject.outputInspectionChanged" ||
        key === "shootingProject.outputInspectionExpired"
      ) {
        try {
          await inspect(targetParent);
        } catch (refreshError) {
          setErrorKey(shootingProjectErrorKey(refreshError));
        }
      }
    } finally {
      setPhase(null);
    }
  }
  return (
    <Dialog onOpenChange={(open) => !(open || busy) && onClose()} open>
      <DialogContent
        className="flex min-h-0 flex-col gap-3 overflow-hidden"
        data-testid="shooting-output-dialog"
        onCloseAutoFocus={(event) => {
          if (!created.current && opener.current?.isConnected) {
            event.preventDefault();
            opener.current.focus({ preventScroll: true });
          }
        }}
        onOpenAutoFocus={() => {
          if (document.activeElement instanceof HTMLElement) {
            opener.current = document.activeElement;
          }
        }}
        showCloseButton={!busy}
        size="lg"
      >
        <DialogHeader className="shrink-0">
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
        <div
          className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto overflow-x-hidden overscroll-contain"
          data-testid="shooting-output-body"
        >
          <IconMotionTrigger asChild disabled={busy}>
            <Button
              className="h-auto min-h-8 w-full whitespace-normal"
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
          {errorKey && !(refreshed && busy) && (
            <div
              className={
                refreshed
                  ? "rounded-md border border-border bg-muted/50 p-2.5 text-xs"
                  : "break-words text-destructive text-xs"
              }
              ref={alert}
              role="alert"
              tabIndex={-1}
            >
              <p>{t(errorKey)}</p>
              {refreshed && inspection && groups.length > 0 && (
                <p className="mt-1 text-muted-foreground">
                  {t("shootingProject.outputReconfirmSidecars")}
                </p>
              )}
            </div>
          )}
          {inspection && (
            <div className="min-w-0 space-y-3">
              <div className="min-w-0 space-y-1 rounded-md bg-muted/50 p-2.5 text-xs">
                <p className="text-muted-foreground [overflow-wrap:anywhere]">
                  {inspection.targetRoot}
                </p>
                <p className="font-medium" data-testid="shooting-output-counts">
                  {t("shootingProject.outputPhotoCounts", {
                    originals: inspection.originalCount,
                    xmp:
                      inspection.xmpCount +
                      included.filter((file) => file.kind === "xmp").length,
                    acr:
                      inspection.acrCount +
                      included.filter((file) => file.kind === "acr").length,
                  })}
                </p>
                <p className="text-muted-foreground">
                  {t("shootingProject.outputRange", {
                    count: inspection.count + included.length,
                    size: shootingProjectBytes(
                      included.reduce(
                        (total, file) => total + file.fileSize,
                        inspection.bytes
                      )
                    ),
                    unavailable: inspection.unavailable,
                  })}
                </p>
                {groups.length === 0 && (
                  <p className="text-muted-foreground leading-relaxed">
                    {t("shootingProject.outputXmp")}
                  </p>
                )}
              </div>
              {groups.length > 0 && (
                <section className="min-w-0 space-y-2 text-xs">
                  <h3 className="font-medium">
                    {t("shootingProject.outputAmbiguityTitle")}
                  </h3>
                  <p className="text-muted-foreground leading-relaxed">
                    {t("shootingProject.outputAmbiguityHelp")}
                  </p>
                  <div className="min-w-0 space-y-2">
                    {groups.map((group) => (
                      <SidecarChoiceGroup
                        choice={decisions.get(group.id)}
                        disabled={busy}
                        group={group}
                        key={group.id}
                        onChange={(action) =>
                          setDecisions((previous) =>
                            new Map(previous).set(group.id, action)
                          )
                        }
                      />
                    ))}
                  </div>
                </section>
              )}
              {inspection.watched && (
                <div className="space-y-2 rounded-md border border-border bg-muted/50 p-3 text-xs">
                  <p>{t("shootingProject.outputWatchWarning")}</p>
                  <label className="flex items-start gap-2">
                    <input
                      checked={acknowledged}
                      className="mt-0.5 shrink-0 accent-primary"
                      data-testid="shooting-output-watch-ack"
                      disabled={busy}
                      onChange={(event) =>
                        setAcknowledged(event.target.checked)
                      }
                      type="checkbox"
                    />
                    <span>{t("shootingProject.outputWatchAcknowledge")}</span>
                  </label>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="min-w-0 shrink-0 space-y-2 border-border border-t pt-3">
          {phase === "inspecting" && (
            <p className="text-muted-foreground text-xs" role="status">
              {t("shootingProject.outputInspecting")}
            </p>
          )}
          {phase !== "inspecting" && remaining > 0 && (
            <p className="text-muted-foreground text-xs" role="status">
              {t("shootingProject.outputAmbiguityRemaining", {
                count: remaining,
              })}
            </p>
          )}
          <DialogFooter className="min-[440px]:flex-row min-[440px]:flex-wrap min-[440px]:justify-end">
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
                remaining > 0 ||
                inspection.count === 0 ||
                (inspection.watched && !acknowledged)
              }
              onClick={create}
              type="button"
            >
              {t(
                phase === "creating"
                  ? "shootingProject.outputCreating"
                  : "shootingProject.startCopy"
              )}
            </Button>
          </DialogFooter>
        </div>
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
  const [expandedManifests, setExpandedManifests] = useState<Set<string>>(
    () => new Set()
  );
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
        const skipped = task.skippedSidecars ?? [];
        const completed = task.items.filter(
          (item) => item.status === "completed" && !item.error
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
            <details
              className="min-w-0 text-xs"
              onToggle={(event) => {
                const open = event.currentTarget.open;
                setExpandedManifests((previous) => {
                  if (previous.has(task.id) === open) {
                    return previous;
                  }
                  const next = new Set(previous);
                  if (open) {
                    next.add(task.id);
                  } else {
                    next.delete(task.id);
                  }
                  return next;
                });
              }}
            >
              <summary className="cursor-pointer text-muted-foreground">
                {t("shootingProject.outputManifest")}
                {skipped.length > 0 &&
                  ` · ${t("shootingProject.outputSkippedCount", {
                    count: skipped.length,
                  })}`}
              </summary>
              {expandedManifests.has(task.id) && (
                <div className="mt-2 max-h-44 space-y-2 overflow-y-auto">
                  {skipped.length > 0 && (
                    <div className="min-w-0 text-muted-foreground">
                      <p className="font-medium">
                        {t("shootingProject.outputSkippedSidecars")}
                      </p>
                      <ul className="mt-1 space-y-1">
                        {skipped.map((file) => (
                          <li className="[overflow-wrap:anywhere]" key={file}>
                            {file}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <ul className="space-y-2">
                    {task.items.map((item) => (
                      <li className="min-w-0" key={item.id}>
                        <p className="break-all">
                          {item.relativePath}
                          {item.kind !== "original" &&
                            ` · ${item.kind.toUpperCase()}`}
                        </p>
                        <p className="break-words text-muted-foreground">
                          {t(
                            item.error === "OUTPUT_RECHECK_UNAVAILABLE"
                              ? "shootingProject.outputItem_recheckPending"
                              : `shootingProject.outputItem_${item.status}`
                          )}{" "}
                          ·{" "}
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
                </div>
              )}
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
          onClose={() => {
            setLibraryOpen(false);
            load();
          }}
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
