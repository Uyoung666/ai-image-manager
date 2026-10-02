import { isReducedMotionEnabled } from "@/actions/ui-preferences";

interface ThemeTransition {
  cancelled: boolean;
  transition?: ViewTransition;
}

let activeThemeTransition: ThemeTransition | null = null;

function clearThemeTransition() {
  const root = document.documentElement;
  delete root.dataset.themeTransition;
  for (const property of [
    "--theme-reveal-x",
    "--theme-reveal-y",
    "--theme-reveal-radius",
  ]) {
    root.style.removeProperty(property);
  }
}

export function cancelThemeViewTransition(): void {
  if (!activeThemeTransition) {
    return;
  }
  activeThemeTransition.cancelled = true;
  activeThemeTransition.transition?.skipTransition();
  activeThemeTransition = null;
  clearThemeTransition();
}

/** Reveal the new document from the visible theme control in CSS pixels. */
export async function startThemeViewTransition(
  control: HTMLElement | null,
  update: () => Promise<void>
): Promise<void> {
  cancelThemeViewTransition();
  if (
    !control ||
    typeof document.startViewTransition !== "function" ||
    isReducedMotionEnabled() ||
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  ) {
    await update();
    return;
  }

  const rect = control.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const radius = Math.hypot(
    Math.max(Math.abs(x), Math.abs(window.innerWidth - x)),
    Math.max(Math.abs(y), Math.abs(window.innerHeight - y))
  );
  const root = document.documentElement;
  root.style.setProperty("--theme-reveal-x", `${x}px`);
  root.style.setProperty("--theme-reveal-y", `${y}px`);
  root.style.setProperty("--theme-reveal-radius", `${radius}px`);
  root.dataset.themeTransition = "circle";

  const active: ThemeTransition = { cancelled: false };
  activeThemeTransition = active;
  // A failed snapshot may never call update. Cache its promise so fallback
  // and the browser callback can never persist the theme twice.
  let updatePromise: Promise<void> | undefined;
  const updateOnce = () => {
    updatePromise ??= Promise.resolve().then(update);
    return updatePromise;
  };

  try {
    try {
      active.transition = document.startViewTransition(updateOnce);
    } catch {
      clearThemeTransition();
      await updateOnce();
      return;
    }
    const { transition } = active;
    const finished = transition.finished.catch(() => undefined);
    const updated = transition.updateCallbackDone.catch(() => undefined);
    if (active.cancelled) {
      transition.skipTransition();
    }
    try {
      await transition.ready;
    } catch {
      // Skipped/unsupported snapshots still need to apply the requested theme.
      transition.skipTransition();
    }
    await updateOnce();
    await updated;
    await finished;
  } finally {
    active.transition?.skipTransition();
    if (activeThemeTransition === active) {
      activeThemeTransition = null;
      clearThemeTransition();
    }
  }
}
