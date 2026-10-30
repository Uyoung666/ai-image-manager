import { FolderOpen } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { openFolderDialog } from "@/actions/shell";
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
import { SmoothInput } from "@/components/ui/smooth-input";
import type {
  ShootingProject,
  ShootingProjectSource,
  ShootingProjectWorkflow,
} from "@/types/shooting-project";
import {
  ShootingProjectSourceStatusLabel,
  shootingProjectErrorKey,
} from "./ShootingProjectStatus";

export function ShootingProjectCreateDialog({
  onClose,
  onCreated,
  initialSource,
}: {
  initialSource?: ShootingProjectSource;
  onClose: () => void;
  onCreated: (project: ShootingProject) => void;
}) {
  const { t } = useTranslation();
  const [source, setSource] = useState<ShootingProjectSource | null>(
    initialSource ?? null
  );
  const [name, setName] = useState(initialSource?.defaultName ?? "");
  const [workflow, setWorkflow] = useState<ShootingProjectWorkflow>("curate");
  const [pkMode, setPkMode] = useState<"quick" | "standard" | "fine">(
    "standard"
  );
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  async function chooseSource() {
    setBusy(true);
    setErrorKey(null);
    try {
      const { path } = await openFolderDialog();
      if (!path) {
        return;
      }
      setSource(null);
      setAcknowledged(false);
      const inspected = await shootingProjectActions.inspectSource(path);
      setSource(inspected);
      setName(inspected.defaultName);
      if (inspected.sourceStatus !== "online") {
        setErrorKey("shootingProject.sourceUnavailable");
      }
    } catch (error) {
      setErrorKey(shootingProjectErrorKey(error));
    } finally {
      setBusy(false);
    }
  }

  async function createProject() {
    if (
      busy ||
      !source ||
      source.sourceStatus !== "online" ||
      !name.trim() ||
      (source.sourceInLibrary && !acknowledged)
    ) {
      return;
    }
    setBusy(true);
    setErrorKey(null);
    try {
      const project = await shootingProjectActions.create({
        sourceRoot: source.sourceRoot,
        name: name.trim(),
        workflow,
        pkMode,
        acknowledgeLibrarySource: acknowledged,
      });
      onCreated(project);
    } catch (error) {
      const key = shootingProjectErrorKey(error);
      setErrorKey(key);
      if (key === "shootingProject.libraryConfirmationRequired") {
        setSource(
          (previous) => previous && { ...previous, sourceInLibrary: true }
        );
        setAcknowledged(false);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog onOpenChange={(open) => !(open || busy) && onClose()} open>
      <DialogContent
        className="max-h-[calc(100dvh-1rem)] max-w-full overflow-y-auto sm:max-w-md"
        data-testid="shooting-project-create-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t("shootingProject.create")}</DialogTitle>
          <DialogDescription>
            {t("shootingProject.createDescription")}
          </DialogDescription>
        </DialogHeader>
        <Button
          className="h-auto min-h-8 max-w-full whitespace-normal py-2"
          data-testid="shooting-project-source-picker"
          disabled={busy}
          onClick={chooseSource}
          type="button"
          variant="outline"
        >
          <FolderOpen aria-hidden="true" />
          {t("shootingProject.chooseSource")}
        </Button>
        {source && (
          <div className="min-w-0 space-y-3">
            <fieldset className="min-w-0 space-y-2" disabled={busy}>
              <legend className="mb-2 font-medium text-xs">
                {t("cullProject.workflow")}
              </legend>
              {(["curate", "duel", "hybrid"] as const).map((value) => (
                <label
                  className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2 has-checked:border-primary has-checked:bg-primary/5"
                  key={value}
                >
                  <input
                    checked={workflow === value}
                    className="mt-1 shrink-0 accent-primary"
                    data-testid={`shooting-workflow-${value}`}
                    name="shooting-workflow"
                    onChange={() => setWorkflow(value)}
                    type="radio"
                    value={value}
                  />
                  <span className="min-w-0 text-xs">
                    <span className="block font-medium">
                      {t(`cullProject.workflow_${value}`)}
                    </span>
                    <span className="block text-muted-foreground">
                      {t(`cullProject.workflow_${value}_hint`)}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
            {workflow !== "curate" && (
              <div
                className="min-w-0 space-y-2"
                data-testid="shooting-create-pk-mode"
              >
                <FilterDropdown
                  ariaLabel={t("cullPkModeLabel")}
                  disabled={busy}
                  onChange={(value) => setPkMode(value as typeof pkMode)}
                  options={[
                    { value: "quick", label: t("cullPkModeQuick") },
                    { value: "standard", label: t("cullPkModeStandard") },
                    { value: "fine", label: t("cullPkModeFine") },
                  ]}
                  placeholder={t("cullPkModeLabel")}
                  value={pkMode}
                />
                <p className="text-muted-foreground text-xs">
                  {t(
                    {
                      quick: "cullPkModeQuickDesc",
                      standard: "cullPkModeStandardDesc",
                      fine: "cullPkModeFineDesc",
                    }[pkMode]
                  )}
                </p>
              </div>
            )}
            <div className="min-w-0 space-y-1 rounded-lg bg-muted/50 p-3">
              <p className="break-all text-foreground text-xs">
                {source.sourceRoot}
              </p>
              <ShootingProjectSourceStatusLabel status={source.sourceStatus} />
            </div>
            <div className="min-w-0 space-y-1.5">
              <label
                className="font-medium text-xs"
                htmlFor="shooting-project-name"
              >
                {t("shootingProject.name")}
              </label>
              <SmoothInput
                className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm"
                data-testid="shooting-project-name"
                disabled={busy}
                id="shooting-project-name"
                maxLength={200}
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
            </div>

            {source.sourceInLibrary && (
              <div className="min-w-0 space-y-3 rounded-lg border border-border bg-muted/40 p-3 text-xs">
                <p className="break-words leading-relaxed">
                  {t("shootingProject.libraryWarning")}
                </p>
                <label
                  className="flex min-w-0 items-start gap-2"
                  htmlFor="shooting-project-library-acknowledgement"
                >
                  <input
                    checked={acknowledged}
                    className="mt-0.5 shrink-0 accent-primary"
                    data-testid="shooting-project-library-acknowledgement"
                    disabled={busy}
                    id="shooting-project-library-acknowledgement"
                    onChange={(event) => setAcknowledged(event.target.checked)}
                    type="checkbox"
                  />
                  <span className="min-w-0 break-words">
                    {t("shootingProject.libraryAcknowledge")}
                  </span>
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
        <DialogFooter className="sticky bottom-0 flex-row justify-end border-border border-t bg-popover pt-3">
          <Button
            disabled={busy}
            onClick={onClose}
            type="button"
            variant="outline"
          >
            {t("cancel")}
          </Button>
          <Button
            data-testid="shooting-project-create-submit"
            disabled={
              busy ||
              !source ||
              source.sourceStatus !== "online" ||
              !name.trim() ||
              (source.sourceInLibrary && !acknowledged)
            }
            onClick={createProject}
            type="button"
          >
            {t(
              busy ? "shootingProject.saving" : "shootingProject.createSubmit"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
