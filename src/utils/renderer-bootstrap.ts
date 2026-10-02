import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

/** A module generation owns its pending initialization, while HMR owns the root. */
export function createRendererBootstrap(
  container: HTMLElement,
  previousRoot?: Root
) {
  const root = previousRoot ?? createRoot(container);
  let active = true;

  return {
    root,
    dispose() {
      active = false;
    },
    async renderAfterInitialization(
      initialize: () => Promise<unknown>,
      content: ReactNode
    ): Promise<void> {
      try {
        await initialize();
      } catch {
        // Language initialization is best-effort; retain the built-in fallback.
      }
      if (active) {
        root.render(content);
      }
    },
  };
}
