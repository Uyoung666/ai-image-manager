import { type RefObject, useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");
const NESTED_OVERLAY_SELECTOR =
  '[data-slot="popover-content"][data-state="open"], [data-slot="dialog-content"][data-state="open"], [data-slot="alert-dialog-content"][data-state="open"]';

export function useModalFocusTrap({
  active,
  containerRef,
  initialFocus = "first",
  onEscape,
  respectNestedOverlays = false,
}: {
  active: boolean;
  containerRef: RefObject<HTMLElement | null>;
  initialFocus?: "first" | "container";
  onEscape: () => void;
  respectNestedOverlays?: boolean;
}) {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) {
      return;
    }

    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const getFocusableElements = () =>
      Array.from(
        containerRef.current?.querySelectorAll<HTMLElement>(
          FOCUSABLE_SELECTOR
        ) ?? []
      ).filter(
        (element) =>
          !element.hidden &&
          element.getAttribute("aria-hidden") !== "true" &&
          element.getClientRects().length > 0
      );

    const focusFrame = requestAnimationFrame(() => {
      const container = containerRef.current;
      if (!container?.contains(document.activeElement)) {
        const target =
          initialFocus === "container" ? container : getFocusableElements()[0];
        target?.focus({ preventScroll: true });
      }
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onEscapeRef.current();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }

      const focusable = getFocusableElements();
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      const activeElement = document.activeElement;
      if (
        event.shiftKey &&
        (activeElement === first ||
          activeElement === containerRef.current ||
          !containerRef.current?.contains(activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (activeElement === last ||
          activeElement === containerRef.current ||
          !containerRef.current?.contains(activeElement))
      ) {
        event.preventDefault();
        first?.focus();
      }
    };

    const handleOverlayKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        (respectNestedOverlays &&
          document.querySelector(NESTED_OVERLAY_SELECTOR))
      ) {
        return;
      }
      handleKeyDown(event);
    };
    document.addEventListener("keydown", handleOverlayKeyDown, true);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleOverlayKeyDown, true);
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [active, containerRef, initialFocus, respectNestedOverlays]);
}
