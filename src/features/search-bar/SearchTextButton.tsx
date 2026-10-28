import { type ComponentProps, useRef, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** Full text is useful only when the visible label actually overflows. */
export function SearchTextButton({
  tooltipText,
  tooltipAlways = false,
  ...props
}: ComponentProps<"button"> & {
  tooltipText?: string;
  tooltipAlways?: boolean;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const button = <button {...props} ref={buttonRef} />;
  if (!tooltipText) {
    return button;
  }
  return (
    <Tooltip
      onOpenChange={(nextOpen) => {
        const label =
          buttonRef.current?.querySelector<HTMLElement>(
            "[data-search-tooltip-text]"
          ) ?? buttonRef.current;
        setOpen(
          Boolean(
            nextOpen &&
              label &&
              (tooltipAlways ||
                label.scrollWidth > label.clientWidth ||
                label.scrollHeight > label.clientHeight)
          )
        );
      }}
      open={open}
    >
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent className="max-w-[min(28rem,calc(100dvw-1rem))] break-words">
        {tooltipText}
      </TooltipContent>
    </Tooltip>
  );
}
