import { isReducedMotionEnabled } from "@/actions/ui-preferences";

let activeAnimation: Animation | null = null;

export function cancelGalleryViewTransition(): void {
  activeAnimation?.cancel();
  activeAnimation = null;
}

function prefersReducedMotion(): boolean {
  return (
    isReducedMotionEnabled() ||
    (typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches)
  );
}

/** Animate only the gallery surface; document snapshots can cover its toolbar. */
export function startGalleryViewTransition(
  update: () => void,
  surface?: HTMLElement | null
): Animation | null {
  cancelGalleryViewTransition();
  update();
  if (!surface?.animate || prefersReducedMotion()) {
    return null;
  }
  try {
    const animation = surface.animate([{ opacity: 0.96 }, { opacity: 1 }], {
      duration: 200,
      easing: "ease-out",
    });
    activeAnimation = animation;
    const clear = () => {
      if (activeAnimation === animation) {
        activeAnimation = null;
      }
    };
    animation.finished.then(clear, clear);
    return animation;
  } catch {
    return null;
  }
}
