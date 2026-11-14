import * as React from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";

import { cn } from "@/utils/tailwind";

const TOOLTIP_CONTENT_CLASS_NAME =
  "z-50 max-w-[260px] rounded-[6px] border border-border bg-popover px-2.5 py-1.5 text-[12px] text-popover-foreground leading-snug shadow-md ring-1 ring-foreground/10 surface-elevated duration-100 data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";

const TooltipPortalContext = React.createContext<HTMLElement | null>(null);
const TooltipInteractionContext = React.createContext<{
  release: (interaction: "pointer" | "focus") => boolean;
  enter: () => void;
  leave: () => void;
} | null>(null);
const TOOLTIP_NAVIGATION_KEYS = new Set([
  "Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
]);

function isTooltipDocumentActive() {
  return document.visibilityState === "visible" && document.hasFocus();
}

function TooltipPortalProvider({
  containerRef,
  children,
}: React.PropsWithChildren<{
  containerRef: React.RefObject<HTMLElement | null>;
}>) {
  const [container, setContainer] = React.useState<HTMLElement | null>(null);
  React.useEffect(() => {
    setContainer(containerRef.current);
  }, [containerRef]);
  return (
    <TooltipPortalContext.Provider value={container}>
      {children}
    </TooltipPortalContext.Provider>
  );
}

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
  delayDuration = 400,
  disabled = false,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root> & { disabled?: boolean }) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
  const [windowInteractionBlocked, setWindowInteractionBlocked] =
    React.useState(() => !isTooltipDocumentActive());
  const interactionBlockedRef = React.useRef(windowInteractionBlocked);
  const windowFocusedRef = React.useRef(true);
  const keyboardNavigationRef = React.useRef(false);

  const hoverTimerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelHover = React.useCallback(() => {
    clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = undefined;
  }, []);
  React.useEffect(() => cancelHover, [cancelHover]);
  React.useEffect(() => {
    if (!disabled) {
      return;
    }
    cancelHover();
    interactionBlockedRef.current = true;
    keyboardNavigationRef.current = false;
    setWindowInteractionBlocked(true);
    setUncontrolledOpen(false);
    onOpenChange?.(false);
  }, [disabled, cancelHover, onOpenChange]);

  React.useEffect(() => {
    const blockInteraction = () => {
      cancelHover();
      // Native focus restoration and pending hover timers can run before React commits.
      interactionBlockedRef.current = true;
      keyboardNavigationRef.current = false;
      setWindowInteractionBlocked(true);
      setUncontrolledOpen(false);
      onOpenChange?.(false);
    };
    const handleWindowBlur = () => {
      windowFocusedRef.current = false;
      blockInteraction();
    };
    const handleWindowFocus = () => {
      windowFocusedRef.current = true;
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        blockInteraction();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      keyboardNavigationRef.current =
        windowFocusedRef.current &&
        isTooltipDocumentActive() &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        TOOLTIP_NAVIGATION_KEYS.has(event.key);
    };
    const handlePointerDown = () => {
      keyboardNavigationRef.current = false;
    };

    window.addEventListener("blur", handleWindowBlur);
    window.addEventListener("focus", handleWindowFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      window.removeEventListener("blur", handleWindowBlur);
      window.removeEventListener("focus", handleWindowFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [onOpenChange, cancelHover]);

  const releaseInteraction = (interaction: "pointer" | "focus") => {
    if (
      disabled || !windowFocusedRef.current ||
      !isTooltipDocumentActive() ||
      (interaction === "focus" &&
        interactionBlockedRef.current &&
        !keyboardNavigationRef.current)
    ) {
      return false;
    }
    interactionBlockedRef.current = false;
    setWindowInteractionBlocked(false);
    return true;
  };

  const handleOpenChange = (nextOpen: boolean) => {
    cancelHover();
    if (
      nextOpen &&
      (disabled || interactionBlockedRef.current ||
        !windowFocusedRef.current ||
        !isTooltipDocumentActive())
    ) {
      return;
    }
    if (controlledOpen === undefined) {
      setUncontrolledOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  };

  return (
    <TooltipProvider>
      <TooltipInteractionContext.Provider value={{
        release: releaseInteraction,
        enter: () => {
          cancelHover();
          if (!interactionBlockedRef.current && releaseInteraction("pointer")) {
            // Layout can move a trigger beneath a stationary pointer without a move event.
            hoverTimerRef.current = setTimeout(() => handleOpenChange(true), delayDuration);
          }
        },
        leave: cancelHover,
      }}>
        <TooltipPrimitive.Root
          delayDuration={delayDuration}
          data-slot="tooltip"
          onOpenChange={handleOpenChange}
          open={
            disabled || windowInteractionBlocked
              ? false
              : (controlledOpen ?? uncontrolledOpen)
          }
          {...props}
        />
      </TooltipInteractionContext.Provider>
    </TooltipProvider>
  );
}

function TooltipTrigger({
  onFocus,
  onPointerMove,
  onPointerEnter,
  onPointerLeave,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  const interaction = React.useContext(TooltipInteractionContext);
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      {...props}
      onPointerEnter={(event) => {
        onPointerEnter?.(event);
        if (!event.defaultPrevented && event.pointerType !== "touch") {
          interaction?.enter();
        }
      }}
      onPointerLeave={(event) => {
        onPointerLeave?.(event);
        interaction?.leave();
      }}
      onFocus={(event) => {
        onFocus?.(event);
        if (!event.defaultPrevented && interaction?.release("focus") === false) {
          event.preventDefault();
        }
      }}
      onPointerMove={(event) => {
        onPointerMove?.(event);
        if (
          !event.defaultPrevented &&
          event.pointerType !== "touch" &&
          interaction?.release("pointer") === false
        ) {
          event.preventDefault();
        }
      }}
    />
  );
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 8,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  const container = React.useContext(TooltipPortalContext);
  return (
    <TooltipPrimitive.Portal container={container ?? undefined}>
      <TooltipPrimitive.Content
        className={cn(TOOLTIP_CONTENT_CLASS_NAME, className)}
        data-overlay-kind="tooltip"
        data-slot="tooltip-content"
        data-surface="overlay"
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
  TooltipPortalProvider,
  TooltipTrigger,
};
