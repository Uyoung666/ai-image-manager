import { flushSync } from "react-dom";
import { isReducedMotionEnabled } from "@/actions/ui-preferences";

const GALLERY_TRANSITION_CLASS = "gallery-mode-transitioning";
let activeTransitionId = 0;

export function cancelGalleryViewTransition(): void {
  activeTransitionId += 1;
  if (typeof document !== "undefined") {
    document.documentElement.classList.remove(GALLERY_TRANSITION_CLASS);
  }
}

function prefersReducedMotion(): boolean {
  return (
    isReducedMotionEnabled() ||
    (typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches)
  );
}

/**
 * Commit a gallery presentation change inside a local View Transition.
 *
 * The native API is intentionally optional: the gallery remains usable in
 * older Chromium builds and in tests, while the CSS named transition keeps
 * the route-level transition from moving the rest of the page.
 */
export function startGalleryViewTransition(
  update: () => void
): ViewTransition | null {
  if (
    typeof document === "undefined" ||
    typeof document.startViewTransition !== "function" ||
    prefersReducedMotion()
  ) {
    update();
    return null;
  }

  const root = document.documentElement;
  root.classList.add(GALLERY_TRANSITION_CLASS);
  const transitionId = ++activeTransitionId;
  let committed = false;
  try {
    const transition = document.startViewTransition(() => {
      committed = true;
      flushSync(update);
    });
    const clearTransitionClass = () => {
      if (activeTransitionId === transitionId) {
        root.classList.remove(GALLERY_TRANSITION_CLASS);
      }
    };
    transition.finished.then(clearTransitionClass, clearTransitionClass);
    return transition;
  } catch {
    if (activeTransitionId === transitionId) {
      root.classList.remove(GALLERY_TRANSITION_CLASS);
    }
    if (!committed) {
      update();
    }
    return null;
  }
}
