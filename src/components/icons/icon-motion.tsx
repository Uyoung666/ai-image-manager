import { domAnimation, LazyMotion } from "motion/react";
import { Slot } from "radix-ui";
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useReducedMotion } from "@/hooks/use-reduced-motion";

const MotionAllowedContext = createContext(false);
export const IconAnimationContext = createContext({
  allowed: false,
  sequence: 0,
  engaged: false,
});

export function IconMotionProvider({ children }: { children: ReactNode }) {
  const appReduced = useReducedMotion();
  const systemReduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [foreground, setForeground] = useState(
    () => document.visibilityState !== "hidden" && document.hasFocus()
  );
  const allowed = foreground && !appReduced && !systemReduced;
  useEffect(() => {
    const update = () =>
      setForeground(
        document.visibilityState !== "hidden" && document.hasFocus()
      );
    window.addEventListener("focus", update);
    const pause = () => setForeground(false);
    window.addEventListener("blur", pause);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", pause);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.iconMotionPaused = String(!allowed);
    if (!allowed) {
      for (const icon of document.querySelectorAll<SVGSVGElement>(
        "[data-favorite-feedback]"
      )) {
        icon.removeAttribute("data-favorite-feedback");
        icon.onanimationend = null;
      }
    }
    return () => {
      delete document.documentElement.dataset.iconMotionPaused;
    };
  }, [allowed]);
  return (
    <MotionAllowedContext.Provider value={allowed}>
      <LazyMotion features={domAnimation} strict>
        {children}
      </LazyMotion>
    </MotionAllowedContext.Provider>
  );
}

interface IconMotionTriggerProps extends ComponentProps<"span"> {
  active?: boolean;
  asChild?: boolean;
  busy?: boolean;
  disabled?: boolean;
}

export function animateFavoriteIcon(element: HTMLElement) {
  if (
    document.documentElement.dataset.iconMotionPaused === "true" ||
    document.documentElement.dataset.reducedMotion === "true" ||
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  ) {
    return;
  }
  const icon = element.querySelector<SVGSVGElement>("[data-favorite-icon]");
  if (!icon) {
    return;
  }
  icon.removeAttribute("data-favorite-feedback");
  icon.getBoundingClientRect();
  icon.setAttribute("data-favorite-feedback", "");
  icon.onanimationend = () => {
    icon.removeAttribute("data-favorite-feedback");
    icon.onanimationend = null;
  };
}

export function IconMotionTrigger({
  asChild = true,
  active,
  busy = false,
  disabled = false,
  children,
  ...props
}: IconMotionTriggerProps) {
  const allowed = useContext(MotionAllowedContext);
  const [sequence, setSequence] = useState(0);
  const [engaged, setEngaged] = useState(false);
  const hovered = useRef(false);
  const focused = useRef(false);
  const previous = useRef(false);
  const previousActive = useRef(active);
  const blocked = busy || disabled;
  const update = useCallback(
    (next: boolean) => {
      const enabled = next && allowed && !blocked;
      if (enabled && !previous.current) {
        setSequence((value) => value + 1);
      }
      previous.current = enabled;
      setEngaged(enabled);
    },
    [allowed, blocked]
  );
  useEffect(() => {
    // Enabling motion or returning to the window must not replay an old hover.
    if (!allowed || blocked) {
      previous.current = false;
      hovered.current = false;
      focused.current = false;
      setEngaged(false);
    }
  }, [allowed, blocked]);
  useEffect(() => {
    if (active !== previousActive.current) {
      previousActive.current = active;
      if (active !== undefined) {
        update(active);
      }
    }
  }, [active, update]);
  const Comp = asChild ? Slot.Root : "span";
  const canInteract = (element: HTMLElement) =>
    !element.matches(":disabled, [aria-disabled='true'], [aria-busy='true']");
  return (
    <IconAnimationContext.Provider
      value={{ allowed: allowed && !blocked, sequence, engaged }}
    >
      <Comp
        {...props}
        data-icon-motion-trigger=""
        onBlur={(event) => {
          props.onBlur?.(event);
          if (event.currentTarget.contains(event.relatedTarget)) {
            return;
          }
          focused.current = false;
          if (active === undefined) {
            update(hovered.current);
          }
        }}
        onClick={(event) => {
          props.onClick?.(event);
          if (allowed && !blocked && canInteract(event.currentTarget)) {
            animateFavoriteIcon(event.currentTarget);
          }
        }}
        onFocus={(event) => {
          props.onFocus?.(event);
          if (!canInteract(event.currentTarget)) {
            return;
          }
          focused.current = true;
          if (active === undefined) {
            update(true);
          }
        }}
        onPointerEnter={(event) => {
          props.onPointerEnter?.(event);
          if (
            event.pointerType === "touch" ||
            !canInteract(event.currentTarget)
          ) {
            return;
          }
          hovered.current = true;
          if (active === undefined) {
            update(true);
          }
        }}
        onPointerLeave={(event) => {
          props.onPointerLeave?.(event);
          hovered.current = false;
          if (active === undefined) {
            update(focused.current);
          }
        }}
      >
        {children}
      </Comp>
    </IconAnimationContext.Provider>
  );
}
