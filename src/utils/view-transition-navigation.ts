import { flushSync } from "react-dom";

export function startNavigationViewTransition(
  navigate: () => Promise<void>
): Promise<void> {
  const transition = document.startViewTransition(() =>
    flushSync(() => navigate())
  );
  return transition.updateCallbackDone;
}
