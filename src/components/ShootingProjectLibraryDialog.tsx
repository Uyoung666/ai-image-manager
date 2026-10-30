import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { shootingProjectActions } from "@/actions/shooting-projects";
import { FilterDropdown } from "@/components/filter-dropdown";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { queryClient } from "@/providers/QueryProvider";
import type { ShootingProjectOutputTask } from "@/types/shooting-project";
import { shootingProjectErrorKey } from "./ShootingProjectStatus";

export function ShootingProjectLibraryDialog({
  projectId,
  tasks,
  photoIds,
  onClose,
}: {
  projectId: string;
  tasks: ShootingProjectOutputTask[];
  photoIds?: string[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const completed = tasks.filter((task) => task.status === "completed");
  const [sourceValue, setSourceValue] = useState(
    completed[0] ? `output:${completed[0].id}` : "original"
  );
  const [inspection, setInspection] = useState<{
    token: string;
    count: number;
    unavailable: number;
    paths: string[];
    photoIds: string[];
  } | null>(null);
  const [result, setResult] = useState<{
    added: number;
    failed: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const request =
    sourceValue === "original"
      ? { projectId, source: "original" as const, photoIds }
      : {
          projectId,
          source: "output" as const,
          taskId: sourceValue.slice(7),
          photoIds,
        };
  // biome-ignore lint/correctness/useExhaustiveDependencies: The receipt must be refreshed only when the selected source or explicit retry changes.
  useEffect(() => {
    let current = true;
    setInspection(null);
    setResult(null);
    setErrorKey(null);
    setLoading(true);
    shootingProjectActions
      .inspectLibrary(request)
      .then((value) => {
        if (current) {
          setInspection(value);
        }
      })
      .catch((error: unknown) => {
        if (current) {
          setErrorKey(shootingProjectErrorKey(error));
        }
      })
      .finally(() => {
        if (current) {
          setLoading(false);
        }
      });
    return () => {
      current = false;
    };
  }, [sourceValue, projectId, retry]);
  async function add() {
    if (!inspection || busy) {
      return;
    }
    setBusy(true);
    setErrorKey(null);
    try {
      setResult(
        await shootingProjectActions.addToLibrary({
          ...request,
          photoIds: inspection.photoIds,
          confirmed: true,
          inspectionToken: inspection.token,
        })
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["folders"] }),
        queryClient.invalidateQueries({ queryKey: ["photos"] }),
        queryClient.invalidateQueries({ queryKey: ["stats"] }),
      ]);
    } catch (error) {
      setErrorKey(shootingProjectErrorKey(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog onOpenChange={(open) => !(open || busy) && onClose()} open>
      <DialogContent data-testid="shooting-library-dialog" size="lg">
        <DialogHeader>
          <DialogTitle>{t("shootingProject.addToLibrary")}</DialogTitle>
          <DialogDescription>
            {t("shootingProject.addLibraryDescription")}
          </DialogDescription>
        </DialogHeader>
        <FilterDropdown
          ariaLabel={t("shootingProject.librarySource")}
          className="w-full max-w-full"
          disabled={busy}
          onChange={setSourceValue}
          options={[
            ...completed.map((task) => ({
              value: `output:${task.id}`,
              label: t("shootingProject.libraryOutput", {
                path: task.targetRoot,
              }),
            })),
            { value: "original", label: t("shootingProject.libraryOriginal") },
          ]}
          placeholder={t("shootingProject.librarySource")}
          value={sourceValue}
        />
        {loading && (
          <p className="text-muted-foreground text-xs">{t("loading")}</p>
        )}
        {inspection && (
          <div className="min-w-0 space-y-2">
            <p className="text-sm">
              {t("shootingProject.libraryRange", {
                count: inspection.count,
                unavailable: inspection.unavailable,
              })}
            </p>
            <ul className="max-h-44 min-w-0 space-y-1 overflow-y-auto rounded-md border border-border p-2 text-xs">
              {inspection.paths.map((path) => (
                <li className="break-all" key={path}>
                  {path}
                </li>
              ))}
            </ul>
          </div>
        )}
        {result && (
          <p className="text-sm" role="status">
            {t("shootingProject.libraryResult", {
              added: result.added,
              failed: result.failed,
            })}
          </p>
        )}
        {errorKey && (
          <div className="space-y-2">
            <p className="break-words text-destructive text-xs" role="alert">
              {t(errorKey)}
            </p>
            <Button
              disabled={busy}
              onClick={() => setRetry((value) => value + 1)}
              type="button"
              variant="outline"
            >
              {t("retry")}
            </Button>
          </div>
        )}
        <DialogFooter>
          <Button
            disabled={busy}
            onClick={onClose}
            type="button"
            variant="outline"
          >
            {t("close")}
          </Button>
          <Button
            data-testid="shooting-library-confirm"
            disabled={
              busy ||
              loading ||
              !inspection ||
              inspection.count === 0 ||
              result !== null
            }
            onClick={add}
            type="button"
          >
            {t(
              busy ? "shootingProject.saving" : "shootingProject.addToLibrary"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
