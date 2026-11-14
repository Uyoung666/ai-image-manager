import { Ellipsis } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { libraryReliabilityActions } from "@/actions/library-reliability";
import { isLibrarySourceUnavailable } from "@/components/LibraryPhotoStatus";
import { LibraryRelinkButton } from "@/components/LibraryRelinkButton";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useLibraryPhotoCheck } from "@/hooks/use-library-photo-check";
import type { LibraryPhotoStatus } from "@/types/library-reliability";

export function LibraryPhotoControls({
  photo,
  variant = "notice",
  onUpdated,
}: {
  photo: LibraryPhotoStatus & { id: number };
  variant?: "notice" | "menu";
  onUpdated?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [acting, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [removal, setRemoval] = useState<Awaited<
    ReturnType<typeof libraryReliabilityActions.inspectMissingRemoval>
  > | null>(null);
  const check = useLibraryPhotoCheck(photo.id, onUpdated);
  const checkOriginal = check.start;
  const busy = acting || check.checking;
  const unavailable = isLibrarySourceUnavailable(photo.sourceStatus);

  async function action(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
    } catch {
      toast.error(t("libraryReliability.error"));
    } finally {
      setBusy(false);
    }
  }

  const checkFeedback = <LibraryCheckFeedback check={check} />;
  const controls = (
    <section className="min-w-0 space-y-2 text-xs">
      <h4 className="font-medium text-muted-foreground">
        {t("libraryReliability.title")}
      </h4>
      <p role="status">
        {photo.sourceStatus
          ? t(`libraryReliability.status.${photo.sourceStatus}`)
          : null}
        {photo.refreshStatus && photo.refreshStatus !== "ready"
          ? ` · ${t(`libraryReliability.status.${photo.refreshStatus}`)}`
          : null}
      </p>
      {photo.sourceAvailableAt && unavailable ? (
        <p className="text-muted-foreground">
          {t("libraryReliability.lastAvailable", {
            interpolation: { escapeValue: false },
            time: new Date(photo.sourceAvailableAt).toLocaleString(
              i18n.language
            ),
          })}
        </p>
      ) : null}
      <p className="text-muted-foreground">
        {t("libraryReliability.checkHint")}
      </p>
      {checkFeedback}
      <div className="flex flex-wrap gap-1.5">
        <Button
          disabled={busy}
          onClick={checkOriginal}
          size="sm"
          variant="outline"
        >
          {t(getCheckLabel(check.checking, variant))}
        </Button>
        {unavailable ? (
          <LibraryRelinkButton
            onApplied={onUpdated}
            target={{ photoId: photo.id }}
          />
        ) : (
          <Button
            disabled={busy}
            onClick={() =>
              action(async () => {
                const result = await libraryReliabilityActions.retryRefresh([
                  photo.id,
                ]);
                if (result.queued > 0) {
                  toast.success(t("libraryReliability.refreshQueued"));
                } else {
                  toast.error(t("libraryReliability.error"));
                }
              })
            }
            size="sm"
            variant="outline"
          >
            {t(
              variant === "menu"
                ? "libraryReliability.regeneratePreview"
                : "libraryReliability.retryRefresh"
            )}
          </Button>
        )}
        {photo.sourceStatus === "missing" && (
          <Button
            disabled={busy}
            onClick={() =>
              action(async () => {
                setRemoval(
                  await libraryReliabilityActions.inspectMissingRemoval([
                    photo.id,
                  ])
                );
              })
            }
            size="sm"
            variant="outline"
          >
            {t("libraryReliability.remove")}
          </Button>
        )}
      </div>
    </section>
  );
  const confirmation = (
    <AlertDialog
      onOpenChange={(open) => {
        if (!(open || busy)) {
          setRemoval(null);
        }
      }}
      open={removal !== null}
    >
      {removal && (
        <AlertDialogContent className="z-[66]" overlayClassName="z-[65]">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("libraryReliability.remove")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("libraryReliability.removeImpact", {
                count: removal.photoIds.length,
              })}
              <br />
              {t("libraryReliability.removeLinks", removal.links)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t("cancel")}</AlertDialogCancel>
            <Button
              disabled={busy || removal.photoIds.length === 0}
              onClick={() =>
                action(async () => {
                  const result = await libraryReliabilityActions.removeMissing(
                    removal.token
                  );
                  setRemoval(null);
                  toast.success(
                    t("libraryReliability.removed", { count: result.removed })
                  );
                })
              }
              variant="destructive"
            >
              {t("confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
    </AlertDialog>
  );
  if (variant === "menu") {
    return (
      <>
        <Popover onOpenChange={setMenuOpen} open={menuOpen}>
          <Tooltip disabled={menuOpen}>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  aria-label={t("libraryReliability.fileActions")}
                  className="shrink-0 text-muted-foreground"
                  size="icon-sm"
                  variant="ghost"
                >
                  <Ellipsis aria-hidden="true" />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent className="z-[70]">
              {t("libraryReliability.fileActions")}
            </TooltipContent>
          </Tooltip>
          <PopoverContent
            align="start"
            className="z-[60] max-h-[calc(100dvh-2rem)] w-72 max-w-[calc(100dvw-2rem)] overflow-y-auto"
          >
            {controls}
          </PopoverContent>
        </Popover>
        {confirmation}
      </>
    );
  }
  if (!unavailable && photo.refreshStatus !== "failed") {
    return null;
  }
  return (
    <>
      <section
        aria-label={t("libraryReliability.title")}
        className="min-w-0 space-y-2 text-xs"
      >
        <p role="status">
          {t(
            `libraryReliability.status.${unavailable ? photo.sourceStatus : "failed"}`
          )}
        </p>
        {unavailable && (
          <p className="text-muted-foreground">
            {t("libraryReliability.cachedHint")}
          </p>
        )}
        {checkFeedback}
        <div className="flex flex-wrap gap-1.5">
          {photo.sourceStatus === "missing" ? (
            <LibraryRelinkButton
              onApplied={onUpdated}
              target={{ photoId: photo.id }}
            />
          ) : (
            <Button
              disabled={busy}
              onClick={() =>
                unavailable
                  ? checkOriginal()
                  : action(async () => {
                      const result =
                        await libraryReliabilityActions.retryRefresh([
                          photo.id,
                        ]);
                      if (result.queued > 0) {
                        toast.success(t("libraryReliability.refreshQueued"));
                        onUpdated?.();
                      } else {
                        toast.error(t("libraryReliability.error"));
                      }
                    })
              }
              size="sm"
              variant="outline"
            >
              {t(
                getCheckLabel(check.checking, unavailable ? "notice" : "retry")
              )}
            </Button>
          )}
          <Button onClick={() => setOpen(true)} size="sm" variant="ghost">
            {t("libraryReliability.resolve")}
          </Button>
        </div>
      </section>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="z-[62]" overlayClassName="z-[61]">
          <DialogHeader>
            <DialogTitle>{t("libraryReliability.resolve")}</DialogTitle>
            <DialogDescription>
              {t("libraryReliability.description")}
            </DialogDescription>
          </DialogHeader>
          {controls}
        </DialogContent>
      </Dialog>
      {confirmation}
    </>
  );
}

function getCheckLabel(
  checking: boolean,
  variant: "menu" | "notice" | "retry"
) {
  const labels = {
    menu: "libraryReliability.checkFile",
    notice: "libraryReliability.check",
    retry: "libraryReliability.retryRefresh",
  };
  return checking ? "libraryReliability.checkingFile" : labels[variant];
}
function LibraryCheckFeedback({
  check,
}: {
  check: ReturnType<typeof useLibraryPhotoCheck>;
}) {
  const { t } = useTranslation();
  if (!check.status) {
    return null;
  }
  let message = t(`libraryReliability.checkState.${check.status}`);
  if (check.status === "done" && check.sourceStatus) {
    message = t("libraryReliability.checkResult", {
      status: t(`libraryReliability.status.${check.sourceStatus}`),
    });
  }
  return (
    <p className="text-muted-foreground" role="status">
      {message}
    </p>
  );
}
