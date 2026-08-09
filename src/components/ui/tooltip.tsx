import * as React from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";

import { cn } from "@/utils/tailwind";

const TOOLTIP_CONTENT_CLASS_NAME =
  "z-50 max-w-[260px] rounded-[6px] border border-border bg-popover px-2.5 py-1.5 text-[12px] text-popover-foreground leading-snug shadow-md ring-1 ring-foreground/10 surface-elevated duration-100 data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";

function TooltipProvider({
  delayDuration = 400,
  skipDelayDuration = 100,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      {...props}
    />
  );
}

function Tooltip({
  onOpenChange,
  open: controlledOpen,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
  const [windowInteractionBlocked, setWindowInteractionBlocked] =
    React.useState(false);

  React.useEffect(() => {
    const blockInteraction = () => {
      setWindowInteractionBlocked(true);
      setUncontrolledOpen(false);
      onOpenChange?.(false);
    };
    const releaseInteraction = () => setWindowInteractionBlocked(false);

    window.addEventListener("blur", blockInteraction);
    document.addEventListener("visibilitychange", blockInteraction);
    window.addEventListener("focusin", releaseInteraction, true);
    window.addEventListener("pointermove", releaseInteraction, true);
    return () => {
      window.removeEventListener("blur", blockInteraction);
      document.removeEventListener("visibilitychange", blockInteraction);
      window.removeEventListener("focusin", releaseInteraction, true);
      window.removeEventListener("pointermove", releaseInteraction, true);
    };
  }, [onOpenChange]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen && windowInteractionBlocked) {
      return;
    }
    if (controlledOpen === undefined) {
      setUncontrolledOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  };

  return (
    <TooltipProvider>
      <TooltipPrimitive.Root
        data-slot="tooltip"
        onOpenChange={handleOpenChange}
        open={
          windowInteractionBlocked
            ? false
            : (controlledOpen ?? uncontrolledOpen)
        }
        {...props}
      />
    </TooltipProvider>
  );
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 8,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        className={cn(
          TOOLTIP_CONTENT_CLASS_NAME,
          className
        )}
        data-slot="tooltip-content"
        side={side}
        sideOffset={sideOffset}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}

export {
  TOOLTIP_CONTENT_CLASS_NAME,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
};
