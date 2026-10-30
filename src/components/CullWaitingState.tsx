import { useState } from "react";
import { useTranslation } from "react-i18next";
import { shootingProjectActions } from "@/actions/shooting-projects";
import { shootingProjectErrorKey } from "@/components/ShootingProjectStatus";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { CullAvailability } from "@/types/cull";

export function CullWaitingState({
  availability,
  onRetry,
  onSourceDetails,
  onReview,
}: {
  availability?: CullAvailability;
  onRetry: () => void;
  onSourceDetails?: () => void;
  onReview?: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const progressing =
    !availability ||
    availability.reason === "scanning" ||
    availability.reason === "previews";
  async function retry() {
    if (!availability || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const project = await shootingProjectActions.open(availability.projectId);
      if (project.sourceStatus === "online") {
        await shootingProjectActions.prepare({
          projectId: project.id,
          retryPreviews: true,
          checkNew:
            availability.reason === "empty" || availability.reason === "failed",
        });
      }
      onRetry();
    } catch (failure) {
      setError(shootingProjectErrorKey(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="flex h-full min-h-0 flex-col items-center justify-center gap-3 overflow-y-auto p-4 text-center"
      data-testid="cull-waiting-state"
      role="status"
    >
      {progressing && <LoadingSpinner size="lg" />}
      <p className="max-w-md break-words text-muted-foreground text-sm">
        {t(
          availability
            ? `cullProject.availability_${availability.reason}`
            : "cullProject.preparing",
          { count: availability?.unavailable ?? 0 }
        )}
      </p>
      {(availability?.unavailable ?? 0) > 0 && (
        <p className="text-muted-foreground text-xs">
          {t("cullProject.unavailableCount", {
            count: availability?.unavailable,
          })}
        </p>
      )}
      {!progressing && (
        <div className="flex max-w-full flex-wrap justify-center gap-2">
          <Button disabled={busy} onClick={retry} variant="outline">
            {t(
              availability?.reason === "empty"
                ? "shootingProject.checkNew"
                : "retry"
            )}
          </Button>
          {onSourceDetails && (
            <Button onClick={onSourceDetails} variant="outline">
              {t("shootingProject.sourceDetails")}
            </Button>
          )}
          {availability?.reason === "insufficient" && onReview && (
            <Button onClick={onReview}>{t("cullProject.curateTab")}</Button>
          )}
        </div>
      )}
      {error && (
        <p className="text-destructive text-xs" role="alert">
          {t(error)}
        </p>
      )}
    </div>
  );
}
