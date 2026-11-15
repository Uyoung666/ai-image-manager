import { useQuery } from "@tanstack/react-query";
import { Check, CircleAlert, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { libraryReliabilityActions as actions } from "@/actions/library-reliability";
import { LibraryPathText } from "@/components/LibraryPathText";
import { isLibrarySourceUnavailable } from "@/components/LibraryPhotoStatus";
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
import { LIBRARY_HEALTH_QUERY } from "@/hooks/use-library-change";
import type { LibraryRefreshMode } from "@/types/library-reliability";
import { libraryErrorKey } from "@/utils/library-error";
import { toGalleryThumbnailUrl } from "@/utils/local-media-url";

type Photo = Awaited<ReturnType<typeof actions.getPhotos>>["items"][number];
export type PhotoCheckState = "checking" | "done" | "failed" | "cancelled";
export function LibrarySettingsPhoto({
  photo,
  busy,
  checkState,
  checkedSourceStatus,
  onUpdated,
  onCheck,
  onRelink,
  onFolder,
}: {
  photo: Photo;
  busy: boolean;
  checkState?: PhotoCheckState;
  checkedSourceStatus?: Photo["sourceStatus"];
  onUpdated: () => void;
  onCheck: () => void;
  onRelink: (path?: string) => void;
  onFolder?: () => void;
}) {
  const { t } = useTranslation();
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string>();
  const [feedback, setFeedback] = useState<string>();
  const [failedCachePath, setFailedCachePath] = useState<string>();
  const [removal, setRemoval] =
    useState<Awaited<ReturnType<typeof actions.inspectMissingRemoval>>>();
  const candidates = useQuery({
    queryKey: [...LIBRARY_HEALTH_QUERY, "candidates", photo.id],
    queryFn: () => actions.getMoveCandidates(photo.id),
    enabled: photo.pendingMoveCount > 0,
  });
  const unavailable = isLibrarySourceUnavailable(photo.sourceStatus);
  const disabled = busy || acting;
  const recovered = photoRecovered(photo);
  const checking = checkState === "checking";
  const canRepairPreview = previewNeedsRepair(photo, failedCachePath);
  async function work(run: () => Promise<void>) {
    setActing(true);
    setError(undefined);
    try {
      await run();
      onUpdated();
    } catch (cause) {
      setError(libraryErrorKey(cause));
    } finally {
      setActing(false);
    }
  }
  async function refresh(mode: LibraryRefreshMode) {
    await work(async () => {
      const result = await actions.retryRefresh([photo.id], mode);
      if (result.queued) {
        setFeedback("libraryReliability.refreshQueued");
      } else {
        setError("libraryReliability.error");
      }
    });
  }
  const { primaryAction, primaryLabel } = recoveryAction(
    photo,
    onCheck,
    onRelink,
    () => refresh("retry")
  );
  const checkingPrimary = checking && primaryAction === onCheck;
  return (
    <article
      className="min-w-0 space-y-3 rounded-md border border-border p-3 text-xs"
      data-surface="card"
    >
      <div className="flex min-w-0 items-start gap-3">
        {photo.thumbnailPath && failedCachePath !== photo.thumbnailPath ? (
          // biome-ignore lint/a11y/noNoninteractiveElementInteractions: Cache load failure recovers to a placeholder.
          <img
            alt=""
            className="size-14 shrink-0 rounded object-contain"
            height={56}
            onError={() => setFailedCachePath(photo.thumbnailPath ?? undefined)}
            src={toGalleryThumbnailUrl(
              photo.id,
              256,
              photo.thumbnailPath ?? "offline",
              undefined,
              true
            )}
            width={56}
          />
        ) : (
          <div className="flex size-14 shrink-0 items-center justify-center rounded bg-muted p-1 text-center text-[10px]">
            {t("libraryReliability.previewUnavailable")}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <LibraryPathText path={photo.filename} />
          <LibraryPathText path={photo.path} />
          <PhotoStatusText photo={photo} />
        </div>
      </div>
      <LastAvailable time={photo.sourceAvailableAt} unavailable={unavailable} />
      {error && (
        <p className="text-destructive" role="alert">
          {t(error)}
        </p>
      )}
      {feedback && <p role="status">{t(feedback)}</p>}
      {recovered && !checkState && (
        <p role="status">{t("libraryReliability.recovered")}</p>
      )}
      {photo.sourceStatus === "offline" && (
        <p className="text-muted-foreground">
          {t("libraryReliability.detail.offline")}
        </p>
      )}
      <div className="flex min-w-0 flex-wrap gap-2 [&_button]:max-w-full [&_button]:whitespace-normal">
        {(unavailable || photo.refreshStatus === "failed" || checking) && (
          <Button
            aria-busy={checkingPrimary}
            disabled={disabled}
            onClick={primaryAction}
          >
            <CheckLabel checking={checkingPrimary} label={t(primaryLabel)} />
          </Button>
        )}
        {photo.folderId && onFolder && (
          <Button disabled={disabled} onClick={onFolder} variant="outline">
            {t("libraryReliability.manageFolder")}
          </Button>
        )}
        {primaryAction !== onCheck && (
          <Button
            aria-busy={checking}
            disabled={disabled}
            onClick={onCheck}
            variant="outline"
          >
            <CheckLabel
              checking={checking}
              label={t("libraryReliability.checkFile")}
            />
          </Button>
        )}
        {unavailable && photo.sourceStatus !== "missing" && (
          <Button
            disabled={disabled}
            onClick={() => onRelink()}
            variant="outline"
          >
            {t("libraryReliability.relink")}
          </Button>
        )}
        {canRepairPreview && (
          <Button
            disabled={disabled}
            onClick={() => refresh("preview")}
            variant="outline"
          >
            {t("libraryReliability.regeneratePreview")}
          </Button>
        )}
        {photo.sourceStatus === "missing" && (
          <Button
            disabled={disabled}
            onClick={() =>
              work(async () =>
                setRemoval(await actions.inspectMissingRemoval([photo.id]))
              )
            }
            variant="destructive"
          >
            {t("libraryReliability.remove")}
          </Button>
        )}
        <PhotoCheckFeedback
          checkState={checkState}
          sourceStatus={checkedSourceStatus ?? photo.sourceStatus}
        />
      </div>
      <MoveCandidates
        candidates={candidates}
        disabled={disabled}
        onRelink={onRelink}
      />
      <AlertDialog
        onOpenChange={(open) => {
          if (!(open || acting)) {
            setRemoval(undefined);
          }
        }}
        open={Boolean(removal)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("libraryReliability.remove")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("libraryReliability.removeImpact", {
                count: removal?.photoIds.length ?? 0,
              })}
              <br />
              {removal && t("libraryReliability.removeLinks", removal.links)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={acting}>
              {t("cancel")}
            </AlertDialogCancel>
            <Button
              disabled={acting || !removal?.photoIds.length}
              onClick={() =>
                work(async () => {
                  if (removal) {
                    await actions.removeMissing(removal.token);
                  }
                  setRemoval(undefined);
                  setFeedback("libraryReliability.removalDone");
                })
              }
              variant="destructive"
            >
              {t("libraryReliability.remove")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </article>
  );
}

function CheckLabel({ checking, label }: { checking: boolean; label: string }) {
  return (
    <>
      {checking && (
        <LoaderCircle
          aria-hidden="true"
          className="size-3.5 animate-spin motion-reduce:animate-none"
        />
      )}
      {label}
    </>
  );
}

function PhotoCheckFeedback({
  checkState,
  sourceStatus,
}: {
  checkState?: PhotoCheckState;
  sourceStatus: Photo["sourceStatus"];
}) {
  const { t } = useTranslation();
  if (!checkState || checkState === "checking") {
    return null;
  }
  const done = checkState === "done";
  const Icon = done ? Check : CircleAlert;
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1 text-muted-foreground"
      role="status"
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {done
        ? t("libraryReliability.checkResult", {
            status: t(`libraryReliability.status.${sourceStatus}`),
          })
        : t(`libraryReliability.checkState.${checkState}`)}
    </span>
  );
}

function recoveryAction(
  photo: Photo,
  onCheck: () => void,
  onRelink: () => void,
  onRetry: () => void
) {
  if (photo.sourceStatus === "missing") {
    return {
      primaryAction: onRelink,
      primaryLabel: "libraryReliability.relink",
    };
  }
  if (
    !isLibrarySourceUnavailable(photo.sourceStatus) &&
    photo.refreshStatus === "failed"
  ) {
    return {
      primaryAction: onRetry,
      primaryLabel: "libraryReliability.retryRefresh",
    };
  }
  return { primaryAction: onCheck, primaryLabel: "libraryReliability.check" };
}

function LastAvailable({
  time,
  unavailable,
}: {
  time?: number | null;
  unavailable: boolean;
}) {
  const { t, i18n } = useTranslation();
  if (!(time && unavailable)) {
    return null;
  }
  return (
    <p className="text-muted-foreground">
      {t("libraryReliability.lastAvailable", {
        time: new Date(time).toLocaleString(i18n.language),
        interpolation: { escapeValue: false },
      })}
    </p>
  );
}

function MoveCandidates({
  candidates,
  disabled,
  onRelink,
}: {
  candidates: {
    isError: boolean;
    data?: Awaited<ReturnType<typeof actions.getMoveCandidates>>;
  };
  disabled: boolean;
  onRelink: (path?: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      {candidates.isError && (
        <p role="alert">{t("libraryReliability.error")}</p>
      )}
      {candidates.data?.map((candidate) => (
        <div
          className="min-w-0 space-y-1 rounded bg-muted p-2"
          key={candidate.targetPath}
        >
          <p>{t(`libraryReliability.candidateReason.${candidate.reason}`)}</p>
          <LibraryPathText path={candidate.targetPath} />
          <Button
            disabled={disabled}
            onClick={() => onRelink(candidate.targetPath)}
            variant="outline"
          >
            {t("libraryReliability.inspectCandidate")}
          </Button>
        </div>
      ))}
    </div>
  );
}

function photoRecovered(photo: Photo) {
  return (
    photo.sourceStatus === "available" &&
    photo.refreshStatus === "ready" &&
    !photo.pendingMoveCount
  );
}

function previewNeedsRepair(photo: Photo, failedPath?: string) {
  return (
    photo.sourceStatus === "available" &&
    failedPath !== undefined &&
    failedPath === photo.thumbnailPath
  );
}

function PhotoStatusText({ photo }: { photo: Photo }) {
  const { t } = useTranslation();
  return (
    <p className="mt-1">
      {t(`libraryReliability.status.${photo.sourceStatus}`)}
      {photo.refreshStatus !== "ready" &&
        ` / ${t(`libraryReliability.status.${photo.refreshStatus}`)}`}
      {photo.pendingMoveCount > 0 &&
        ` / ${t("libraryReliability.manageStatus.move")}`}
    </p>
  );
}
