import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { cullActions } from "@/actions/cull";
import { shootingProjectActions } from "@/actions/shooting-projects";
import type { CullArchiveTask } from "@/types/cull";

export const CULL_ARCHIVE_CHANGED = "cull-archive-changed";
const revisions = new Map<string, number>();

async function saveArchive(task: CullArchiveTask, archived: boolean) {
  if (task.kind === "project") {
    await shootingProjectActions.archive({ projectId: task.id, archived });
  } else {
    await cullActions.archiveSession({ sessionId: task.id, archived });
  }
  window.dispatchEvent(
    new CustomEvent(CULL_ARCHIVE_CHANGED, {
      detail: { kind: task.kind, id: task.id },
    })
  );
}

export function useCullArchiveRefresh(
  kind: CullArchiveTask["kind"],
  id: string | number,
  refresh: () => void
) {
  useEffect(() => {
    const changed = (event: Event) => {
      const task = (event as CustomEvent<{ kind: string; id: string | number }>)
        .detail;
      if (task?.kind === kind && task.id === id) {
        refresh();
      }
    };
    window.addEventListener(CULL_ARCHIVE_CHANGED, changed);
    return () => window.removeEventListener(CULL_ARCHIVE_CHANGED, changed);
  }, [kind, id, refresh]);
}

export function useCullTaskArchive() {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  async function toggle(task: CullArchiveTask, onChanged?: () => void) {
    if (pending) {
      return;
    }
    const key = `${task.kind}:${task.id}`;
    const previous = task.archivedAt != null;
    setPending(true);
    try {
      await saveArchive(task, !previous);
      const revision = (revisions.get(key) ?? 0) + 1;
      revisions.set(key, revision);
      onChanged?.();
      toast.success(
        t(
          previous
            ? "cullProject.archive.restored"
            : "cullProject.archive.archived",
          {
            name: task.name,
          }
        ),
        {
          id: "cull-task-archive",
          duration: 8000,
          action: {
            label: t("cullUndo"),
            onClick: async () => {
              if (revisions.get(key) !== revision) {
                toast.info(t("cullProject.archive.undoExpired"));
                return;
              }
              revisions.set(key, revision + 1);
              try {
                await saveArchive(task, previous);
              } catch {
                if (revisions.get(key) === revision + 1) {
                  revisions.set(key, revision);
                }
                toast.error(t("cullActionFailed"));
              }
            },
          },
        }
      );
    } catch {
      toast.error(t("cullActionFailed"));
    } finally {
      setPending(false);
    }
  }
  return { pending, toggle };
}
