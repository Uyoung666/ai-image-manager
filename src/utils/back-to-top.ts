import { isReducedMotionEnabled } from "@/actions/ui-preferences";

const SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
  "Escape",
]);

export function shouldShowBackToTop(element: HTMLElement): boolean {
  return (
    element.clientHeight > 0 && element.scrollTop > element.clientHeight * 2
  );
}

/** One controller per scroll surface. Input always takes precedence over a pending jump. */
export function createBackToTopController(
  element: HTMLElement,
  onPositioned?: () => void
) {
  let active = false;
  let animation: Animation | null = null;
  let frame = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let smooth = false;

  function positionAtTop() {
    element.scrollTo({ top: 0, behavior: "instant" });
    onPositioned?.();
  }

  const cancel = () => {
    active = false;
    animation?.cancel();
    animation = null;
    cancelAnimationFrame(frame);
    clearTimeout(timeout);
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("wheel", cancel, true);
    document.removeEventListener("touchstart", cancel, true);
    document.removeEventListener("keydown", onKeyDown, true);
    element.removeEventListener("scrollend", finish);
    window.removeEventListener("blur", cancel);
    window.removeEventListener("resize", cancel);
    if (smooth) {
      smooth = false;
      element.scrollTo({ top: element.scrollTop, behavior: "instant" });
    }
  };

  function finish() {
    cancel();
  }

  function onPointerDown(event: PointerEvent) {
    if (!(event.target as Element).closest?.(".scroll-to-top-btn")) {
      cancel();
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (SCROLL_KEYS.has(event.key)) {
      cancel();
    }
  }

  function fadeIn(surface: HTMLElement) {
    // Two frames allow the virtual window's scroll handler and React commit
    // to place the first cards before revealing them. Image decode stays async.
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (!active) {
          return;
        }
        const previous = animation;
        try {
          const reveal = surface.animate([{ opacity: 0.35 }, { opacity: 1 }], {
            duration: 160,
            easing: "cubic-bezier(0.2, 0, 0, 1)",
            fill: "both",
          });
          animation = reveal;
          previous?.cancel();
          reveal.finished.then(
            () => {
              if (animation === reveal) {
                finish();
              }
            },
            () => {
              if (animation === reveal) {
                cancel();
              }
            }
          );
        } catch {
          finish();
        }
      });
    });
  }

  function start(keyboardActivation: boolean, onStart?: () => void) {
    if (active) {
      return;
    }
    if (keyboardActivation) {
      // Move focus before the button hides during the scroll, without moving
      // the viewport. Further keyboard navigation can interrupt the transition.
      element.focus({ preventScroll: true });
    }
    active = true;
    onStart?.();
    const reduced =
      isReducedMotionEnabled() ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced || element.scrollTop <= 1) {
      positionAtTop();
      finish();
      return;
    }

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("wheel", cancel, {
      capture: true,
      passive: true,
    });
    document.addEventListener("touchstart", cancel, {
      capture: true,
      passive: true,
    });
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", cancel);
    window.addEventListener("resize", cancel);
    if (element.scrollTop <= element.clientHeight * 4) {
      smooth = true;
      element.addEventListener("scrollend", finish);
      timeout = setTimeout(finish, 1500);
      element.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    const surface = element.querySelector<HTMLElement>(
      "[data-back-to-top-content]"
    );
    if (!surface?.animate) {
      positionAtTop();
      finish();
      return;
    }
    try {
      // Keep enough content visible to avoid an empty or flashing viewport.
      const fade = surface.animate([{ opacity: 1 }, { opacity: 0.35 }], {
        duration: 80,
        easing: "ease-out",
        fill: "both",
      });
      animation = fade;
      fade.finished.then(
        () => {
          if (!active || animation !== fade) {
            return;
          }
          positionAtTop();
          fadeIn(surface);
        },
        () => {
          if (animation === fade) {
            cancel();
          }
        }
      );
    } catch {
      positionAtTop();
      finish();
    }
  }

  return { start, cancel };
}
