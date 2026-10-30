import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { SmoothInput } from "@/components/ui/smooth-input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
  ShootingProject,
  ShootingProjectWorkspaceData,
} from "@/types/shooting-project";
import {
  shootingProjectBytes,
  shootingProjectErrorKey,
} from "./ShootingProjectStatus";

export function ShootingProjectManagement({
  project,
  previewBytes,
  onChanged,
  onWorkspace,
  onDeleted,
  onOutputs,
}: {
  project: ShootingProject;
  previewBytes: number;
  onChanged: () => void;
  onWorkspace: (data: ShootingProjectWorkspaceData) => void;
  onDeleted: () => void;
  onOutputs?: () => void;
}) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [action, setAction] = useState<
    "rename" | "delete" | "clearPreviews" | null
  >(null);
  const [name, setName] = useState(project.name);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  async function submit() {
    if (!action || busy) {
      return;
    }
    setBusy(true);
    setErrorKey(null);
    try {
      if (action === "rename") {
        await shootingProjectActions.rename({
          projectId: project.id,
          name: name.trim(),
        });
        onChanged();
      }
      if (action === "delete") {
        await shootingProjectActions.delete(project.id);
        onDeleted();
      }
      if (action === "clearPreviews") {
        onWorkspace(await shootingProjectActions.clearPreviews(project.id));
      }
      setAction(null);
    } catch (error) {
      setErrorKey(shootingProjectErrorKey(error));
    } finally {
      setBusy(false);
    }
  }
  const titleKey = action;
  return (
    <>
      <Popover onOpenChange={setMenuOpen} open={menuOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                aria-label={t("shootingProject.manage")}
                data-testid="shooting-project-manage"
                size="icon"
                type="button"
                variant="outline"
              >
                <MoreHorizontal />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>{t("shootingProject.manage")}</TooltipContent>
        </Tooltip>
        <PopoverContent
          align="end"
          className="max-h-[var(--radix-popover-content-available-height)] w-56 max-w-[calc(100dvw-1rem)] gap-1 overflow-y-auto"
        >
          {onOutputs && (
            <Button
              className="h-auto min-h-8 justify-start whitespace-normal text-left"
              onClick={() => {
                setMenuOpen(false);
                onOutputs();
              }}
              variant="ghost"
            >
              {t("cullProject.outputTasks")}
            </Button>
          )}
          {(["rename", "clearPreviews", "delete"] as const).map((value) => (
            <Button
              className="h-auto min-h-8 justify-start whitespace-normal text-left"
              data-testid={`shooting-project-${value}`}
              key={value}
              onClick={() => {
                setAction(value);
                setName(project.name);
                setErrorKey(null);
                setMenuOpen(false);
              }}
              type="button"
              variant={value === "delete" ? "destructive" : "ghost"}
            >
              {t(`shootingProject.${value}`)}
            </Button>
          ))}
        </PopoverContent>
      </Popover>
      <Dialog
        onOpenChange={(open) => !(open || busy) && setAction(null)}
        open={action !== null}
      >
        <DialogContent data-testid="shooting-project-manage-dialog">
          <DialogHeader>
            <DialogTitle>{t(`shootingProject.${titleKey}`)}</DialogTitle>
            <DialogDescription>
              {t(`shootingProject.${action}Description`)}
            </DialogDescription>
          </DialogHeader>
          {action === "rename" && (
            <div className="space-y-1.5">
              <label className="text-xs" htmlFor="shooting-project-rename">
                {t("shootingProject.name")}
              </label>
              <SmoothInput
                className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm"
                disabled={busy}
                id="shooting-project-rename"
                maxLength={200}
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
            </div>
          )}
          {action === "clearPreviews" && (
            <p className="text-muted-foreground text-xs">
              {t("shootingProject.previewUsage", {
                size: shootingProjectBytes(previewBytes),
              })}
            </p>
          )}
          {errorKey && (
            <p className="break-words text-destructive text-xs" role="alert">
              {t(errorKey)}
            </p>
          )}
          <DialogFooter>
            <Button
              disabled={busy}
              onClick={() => setAction(null)}
              type="button"
              variant="outline"
            >
              {t("cancel")}
            </Button>
            <Button
              data-testid="shooting-project-manage-confirm"
              disabled={busy || (action === "rename" && !name.trim())}
              onClick={submit}
              type="button"
              variant={action === "delete" ? "destructive" : "default"}
            >
              {t(busy ? "shootingProject.saving" : "confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
