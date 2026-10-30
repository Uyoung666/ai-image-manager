import { FolderOpen } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { openFolderDialog } from "@/actions/shell";
import { shootingProjectActions } from "@/actions/shooting-projects";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  ShootingProjectRelinkInspection,
  ShootingProjectWorkspaceData,
} from "@/types/shooting-project";
import { shootingProjectErrorKey } from "./ShootingProjectStatus";

export function ShootingProjectRelinkDialog({
  projectId,
  onClose,
  onComplete,
}: {
  projectId: string;
  onClose: () => void;
  onComplete: (data: ShootingProjectWorkspaceData) => void;
}) {
  const { t } = useTranslation();
  const [inspection, setInspection] =
    useState<ShootingProjectRelinkInspection | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  async function inspect() {
    setBusy(true);
    setErrorKey(null);
    try {
      const { path } = await openFolderDialog();
      if (!path) {
        return;
      }
      setInspection(null);
      setAccepted(false);
      setInspection(
        await shootingProjectActions.inspectRelink({
          projectId,
          sourceRoot: path,
        })
      );
    } catch (error) {
      setErrorKey(shootingProjectErrorKey(error));
    } finally {
      setBusy(false);
    }
  }
  async function commit() {
    if (!inspection || busy) {
      return;
    }
    setBusy(true);
    setErrorKey(null);
    try {
      const result = await shootingProjectActions.commitRelink({
        projectId,
        token: inspection.token,
        acceptCandidates: accepted,
      });
      onComplete(result);
      onClose();
    } catch (error) {
      setErrorKey(shootingProjectErrorKey(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog onOpenChange={(open) => !(open || busy) && onClose()} open>
      <DialogContent data-testid="shooting-relink-dialog" size="lg">
        <DialogHeader>
          <DialogTitle>{t("shootingProject.relink")}</DialogTitle>
          <DialogDescription>
            {t("shootingProject.relinkDescription")}
          </DialogDescription>
        </DialogHeader>
        <Button
          data-testid="shooting-relink-choose"
          disabled={busy}
          onClick={inspect}
          type="button"
          variant="outline"
        >
          <FolderOpen />
          {t("shootingProject.chooseNewRoot")}
        </Button>
        {inspection && (
          <div className="min-w-0 space-y-3">
            <p className="break-all text-xs">{inspection.sourceRoot}</p>
            <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
              {(
                [
                  "verified",
                  "candidates",
                  "missing",
                  "changed",
                  "insufficient",
                ] as const
              ).map((status) => (
                <div className="rounded-md bg-muted/50 p-2" key={status}>
                  <dt className="text-muted-foreground">
                    {t(`shootingProject.relink_${status}`)}
                  </dt>
                  <dd className="mt-1 font-medium">{inspection[status]}</dd>
                </div>
              ))}
            </dl>
            <p className="text-muted-foreground text-xs leading-relaxed">
              {t("shootingProject.relinkEvidence")}
            </p>
            {inspection.candidates > 0 && (
              <label className="flex items-start gap-2 text-xs">
                <input
                  checked={accepted}
                  className="mt-0.5 shrink-0 accent-primary"
                  data-testid="shooting-relink-accept"
                  disabled={busy}
                  onChange={(event) => setAccepted(event.target.checked)}
                  type="checkbox"
                />
                <span>{t("shootingProject.relinkAcceptCandidates")}</span>
              </label>
            )}
            <ul className="max-h-40 min-w-0 space-y-1 overflow-y-auto rounded-md border border-border p-2 text-xs">
              {inspection.items.map((item) => (
                <li className="break-all" key={item.photoId}>
                  {item.relativePath} —{" "}
                  {t(`shootingProject.relinkItem_${item.status}`)}
                </li>
              ))}
            </ul>
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
            data-testid="shooting-relink-confirm"
            disabled={
              busy ||
              !inspection ||
              inspection.verified + inspection.candidates === 0 ||
              (inspection.candidates > 0 && !accepted)
            }
            onClick={commit}
            type="button"
          >
            {t(
              busy ? "shootingProject.saving" : "shootingProject.relinkConfirm"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
