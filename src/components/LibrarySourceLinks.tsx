import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { libraryReliabilityActions } from "@/actions/library-reliability";
import { FolderDotIcon } from "@/components/icons/folder-dot";
import { IconMotionTrigger } from "@/components/icons/icon-motion";
import { isLibrarySourceUnavailable } from "@/components/LibraryPhotoStatus";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { LIBRARY_HEALTH_QUERY } from "@/hooks/use-library-change";
import type { LibraryPhotoStatus } from "@/types/library-reliability";

export function LibraryAttentionLink() {
  const { t } = useTranslation();
  const returnIndex = useLocation({
    select: (location) => location.state.__TSR_index,
  });
  const { data } = useQuery({
    queryKey: [...LIBRARY_HEALTH_QUERY, "attention"],
    queryFn: () => libraryReliabilityActions.getAttention(),
  });
  if (!(data?.attentionCount || data?.offlineCount)) {
    return null;
  }
  const label = t(
    data.attentionCount
      ? "libraryReliability.attentionLink"
      : "libraryReliability.offlineLink",
    {
      count: data.attentionCount || data.offlineCount,
    }
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <IconMotionTrigger asChild>
          <Button
            asChild
            className={
              data.attentionCount
                ? "relative border-warning/30 bg-warning/10 text-warning hover:bg-warning/20 hover:text-warning"
                : "relative text-muted-foreground"
            }
            size="icon-lg"
            variant="outline"
          >
            <Link
              aria-label={label}
              state={{ libraryReturnIndex: returnIndex }}
              to="/settings/library"
            >
              <FolderDotIcon />
              {Boolean(data.attentionCount) && (
                <span
                  aria-hidden="true"
                  className="absolute top-1 right-1 size-1.5 rounded-full bg-warning ring-2 ring-background"
                />
              )}
            </Link>
          </Button>
        </IconMotionTrigger>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function LibraryPhotoNotice({
  photo,
  showingCache,
  onResolve,
}: {
  photo: LibraryPhotoStatus & { id: number };
  showingCache: boolean;
  onResolve?: (photoId: number) => void;
}) {
  const { t } = useTranslation();
  const unavailable = isLibrarySourceUnavailable(photo.sourceStatus);
  const failed = photo.refreshStatus === "failed";
  if (!(unavailable || failed)) {
    return null;
  }
  return (
    <div
      className={`flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md p-2 text-xs ${photo.sourceStatus === "offline" && !failed ? "bg-muted text-muted-foreground" : "bg-warning/10"}`}
    >
      <p className="min-w-0 flex-1 basis-32 [overflow-wrap:anywhere]">
        {t(
          `libraryReliability.detail.${unavailable ? photo.sourceStatus : "failed"}`
        )}
        {unavailable && failed && ` ${t("libraryReliability.detail.failed")}`}
        {unavailable &&
          showingCache &&
          ` ${t("libraryReliability.detail.cached")}`}
      </p>
      {onResolve && (
        <Button onClick={() => onResolve(photo.id)} size="sm" variant="link">
          {t("libraryReliability.goToSettings")}
        </Button>
      )}
    </div>
  );
}
