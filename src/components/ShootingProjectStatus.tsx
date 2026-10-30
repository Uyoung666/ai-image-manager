import { FolderOpen, ShieldAlert, WifiOff } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
  ShootingProjectPhotoStatus,
  ShootingProjectSourceStatus,
} from "@/types/shooting-project";

export const SHOOTING_PHOTO_STATUS_KEYS: Record<
  ShootingProjectPhotoStatus,
  string
> = {
  pending: "shootingProject.pending",
  undecided: "shootingProject.undecided",
  kept: "shootingProject.kept",
  rejected: "shootingProject.rejected",
};

export function ShootingProjectIconButton({
  label,
  children,
  ...props
}: ComponentProps<typeof Button> & { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          size="icon"
          type="button"
          variant="outline"
          {...props}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function shootingProjectBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const ERROR_KEYS: Record<string, string> = {
  LIBRARY_INSPECTION_EXPIRED: "libraryInspectionExpired",
  LIBRARY_SCOPE_CHANGED: "libraryScopeChanged",
  LIBRARY_EMPTY: "libraryEmpty",
  SOURCE_CHANGED: "outputSourceChanged",
  PREVIEW_UNAVAILABLE: "previewFailed",
  RELINK_CONFIRMATION_REQUIRED: "relinkAcceptCandidates",
  OUTPUT_INVALID_TARGET: "outputInvalidTarget",
  OUTPUT_TARGET_INSIDE_SOURCE: "outputInsideSource",
  OUTPUT_WATCH_CONFIRMATION_REQUIRED: "outputWatchRequired",
  OUTPUT_EMPTY: "outputEmpty",
  OUTPUT_NOT_FOUND: "outputNotFound",
  OUTPUT_BUSY: "outputBusy",
  OUTPUT_SOURCE_CHANGED: "outputSourceChanged",
  OUTPUT_CONFLICT: "outputConflict",
  OUTPUT_NO_SPACE: "outputNoSpace",
  OUTPUT_PERMISSION_DENIED: "outputPermission",
  OUTPUT_SOURCE_UNAVAILABLE: "sourceUnavailable",
  OUTPUT_VERIFY_FAILED: "outputVerifyFailed",
  OUTPUT_CANCELLED: "outputCancelled",
  OUTPUT_UNVERIFIED: "outputUnverified",
  RELINK_EXPIRED: "relinkExpired",
  RELINK_INVALID: "relinkExpired",
  INVALID_RELINK: "relinkExpired",
  PROJECT_BUSY: "projectBusy",
};

const SOURCE_STATUS_KEYS = {
  online: "shootingProject.sourceOnline",
  offline: "shootingProject.sourceOffline",
  inaccessible: "shootingProject.sourceInaccessible",
} as const;

export function ShootingProjectSourceStatusLabel({
  status,
}: {
  status: ShootingProjectSourceStatus;
}) {
  const { t } = useTranslation();
  const Icon = {
    online: FolderOpen,
    offline: WifiOff,
    inaccessible: ShieldAlert,
  }[status];
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs"
      data-status={status}
      data-testid="shooting-project-source-status"
    >
      <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      {t(SOURCE_STATUS_KEYS[status])}
    </span>
  );
}

export function shootingProjectErrorKey(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error ? error.code : null;
  if (typeof code === "string" && ERROR_KEYS[code]) {
    return `shootingProject.${ERROR_KEYS[code]}`;
  }
  switch (code) {
    case "INVALID_SOURCE":
      return "shootingProject.invalidSource";
    case "SOURCE_UNAVAILABLE":
      return "shootingProject.sourceUnavailable";
    case "INVALID_NAME":
      return "shootingProject.invalidName";
    case "LIBRARY_CONFIRMATION_REQUIRED":
      return "shootingProject.libraryConfirmationRequired";
    case "NOT_FOUND":
      return "shootingProject.notFound";
    default:
      return "shootingProject.actionFailed";
  }
}
