// biome-ignore-all lint/a11y/noNoninteractiveTabindex: the status is focusable so keyboard users can read its full Tooltip.
import { Eye } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export function RecentlyViewedBadge({
  frame,
  className = "bottom-0",
  inline = false,
}: {
  frame?: number;
  className?: string;
  inline?: boolean;
}) {
  const { t } = useTranslation();
  const label =
    frame === undefined
      ? t("recentlyViewedPhoto")
      : t("recentlyViewedSequenceFrame", { frame });
  return (
    <div
      className={
        inline
          ? "flex h-6 min-w-0 items-center"
          : `absolute inset-x-0 z-10 flex h-6 items-center px-2 ${className}`
      }
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            aria-label={label}
            className="inline-flex max-w-full items-center gap-1 rounded-full border border-primary/30 bg-background/85 px-1.5 py-0.5 font-medium text-[10px] text-primary shadow-sm backdrop-blur-sm"
            data-recently-viewed="true"
            role="status"
            tabIndex={0}
          >
            <Eye aria-hidden="true" className="h-3 w-3 shrink-0" />
            <span className="truncate">{label}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </div>
  );
}
