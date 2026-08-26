import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { isReducedMotionEnabled } from "@/actions/ui-preferences";
import { routeTree } from "@/routeTree.gen";
import { startNavigationViewTransition } from "@/utils/view-transition-navigation";

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export const router = createRouter({
  routeTree,
  history: createMemoryHistory({
    initialEntries: ["/"],
  }),
});

if (typeof window !== "undefined") {
  window.__e2eNavigate = async (to: string) => {
    await router.navigate({ to: to as never });
    return router.state.location.pathname;
  };
}

// View Transition API — native Chromium crossfade between all route changes.
// flushSync commits React synchronously so startViewTransition can capture
// the correct before/after screenshots within its callback.
// Skip animation when navigating between settings sub-routes (sidebar tab switch).
const _orig = router.navigate;
// biome-ignore lint/suspicious/noExplicitAny: router.navigate has a complex generic signature; the opaque cast is intentional
router.navigate = ((opts: any) => {
  if (
    typeof document !== "undefined" &&
    typeof document.startViewTransition === "function" &&
    !window.electronAPI?.isE2E &&
    !isReducedMotionEnabled()
  ) {
    const currentPath = router.state.location.pathname;
    const targetPath =
      typeof opts === "string" ? opts : (opts?.to ?? currentPath);
    // Search-param and tab changes within one page are state updates, not
    // page navigation. Animating them makes the whole page flash on every
    // dashboard filter click.
    if (currentPath === targetPath) {
      return _orig.call(router, opts);
    }
    // Skip view transition when switching between settings sub-pages
    if (
      currentPath.startsWith("/settings") &&
      targetPath.startsWith("/settings")
    ) {
      return _orig.call(router, opts);
    }
    return startNavigationViewTransition(() => _orig.call(router, opts));
  }
  return _orig.call(router, opts);
}) as typeof router.navigate;
