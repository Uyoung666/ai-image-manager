// biome-ignore-all lint/a11y/noNoninteractiveTabindex: Status tooltips are keyboard-focusable as required by the shared tooltip convention.
import { useTranslation } from "react-i18next";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
  LibraryPhotoStatus,
  LibrarySourceStatus,
} from "@/types/library-reliability";

export function isLibrarySourceUnavailable(status?: LibrarySourceStatus) {
  return (
    status === "offline" || status === "missing" || status === "inaccessible"
  );
}

export function LibraryPhotoStatusBadge({
  sourceStatus,
  refreshStatus,
}: LibraryPhotoStatus) {
  const { t } = useTranslation();
  let label: string | null = null;
  if (refreshStatus === "failed") {
    label = t(`libraryReliability.status.${refreshStatus}`);
  }
  if (isLibrarySourceUnavailable(sourceStatus)) {
    label = t(`libraryReliability.status.${sourceStatus}`);
  }
  if (!label) {
    return null;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="absolute right-1 bottom-1 z-10 max-w-[calc(100%-0.5rem)] truncate rounded bg-popover/90 px-1.5 py-0.5 text-[10px] text-popover-foreground shadow-sm focus-visible:outline-2 focus-visible:outline-ring"
          tabIndex={0}
        >
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
