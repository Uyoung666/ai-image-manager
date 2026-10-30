import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { cullActions } from "@/actions/cull";
import { IconMotionTrigger } from "@/components/icons/icon-motion";
import { Trash2 } from "@/components/icons/trash-2";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CULL_ARCHIVE_CHANGED } from "@/hooks/use-cull-task-archive";
import type { CullTaskSummary } from "@/types/cull";

export function CullArchiveActions({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<CullTaskSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  async function inspect() {
    setBusy(true);
    try {
      const all = await cullActions.listTaskSummaries({
        archived: true,
        search: "",
      });
      if (all.length === 0) {
        toast.info(t("cullProject.archive.empty"));
        return;
      }
      setError(false);
      setTasks(all);
    } catch {
      toast.error(t("cullActionFailed"));
    } finally {
      setBusy(false);
    }
  }
  async function clear() {
    if (busy || !tasks) {
      return;
    }
    setBusy(true);
    setError(false);
    try {
      const snapshot: Parameters<
        typeof cullActions.clearArchivedTasks
      >[0]["tasks"] = [];
      for (const task of tasks) {
        if (task.archivedAt != null) {
          snapshot.push(
            task.kind === "project"
              ? { kind: "project", id: task.id, archivedAt: task.archivedAt }
              : { kind: "library", id: task.id, archivedAt: task.archivedAt }
          );
        }
      }
      const result = await cullActions.clearArchivedTasks({
        confirmed: true,
        tasks: snapshot,
      });
      window.dispatchEvent(new Event(CULL_ARCHIVE_CHANGED));
      if (result.failed) {
        setError(true);
        return;
      }
      setTasks(null);
      toast.success(
        t("cullProject.archive.cleared", { count: result.deleted })
      );
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label={t("cullProject.back")}
            data-testid="cull-archive-list-link"
            onClick={onBack}
            size="icon"
            variant="ghost"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("cullProject.back")}</TooltipContent>
      </Tooltip>
      <IconMotionTrigger asChild disabled={busy}>
        <Button
          className="h-8 text-destructive text-xs hover:bg-destructive/10 hover:text-destructive"
          data-testid="cull-clear-archives"
          disabled={busy}
          onClick={inspect}
          variant="ghost"
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t("cullProject.archive.clearAll")}
        </Button>
      </IconMotionTrigger>
      <Dialog
        onOpenChange={(open) => {
          if (!(open || busy)) {
            setTasks(null);
          }
        }}
        open={tasks !== null}
      >
        <DialogContent data-testid="cull-clear-archives-dialog">
          <DialogHeader>
            <DialogTitle>
              {t("cullProject.archive.clearTitle", {
                count: tasks?.length ?? 0,
              })}
            </DialogTitle>
            <DialogDescription>
              {t("cullProject.archive.clearDescription")}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p className="text-destructive text-sm" role="alert">
              {t("cullProject.archive.clearFailed")}
            </p>
          )}
          <DialogFooter>
            <Button
              disabled={busy}
              onClick={() => setTasks(null)}
              variant="outline"
            >
              {t("cancel")}
            </Button>
            <Button
              data-testid="cull-clear-archives-confirm"
              disabled={busy}
              onClick={clear}
              variant="destructive"
            >
              {t(
                busy ? "shootingProject.saving" : "cullProject.archive.clearAll"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
