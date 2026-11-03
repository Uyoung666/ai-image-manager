import { useEffect } from "react";
import { getUpdateStartupContext, reportUpdateStartup } from "@/actions/update";

export function reportUpdateSurfaceFailure(): void {
  Promise.resolve()
    .then(() => getUpdateStartupContext())
    .then((context) => context && reportUpdateStartup(context.nonce, false))
    .catch(() => undefined);
}

/** Mount only within the successful route tree, after the real surface is ready. */
export function UpdateStartupReady({ ready }: { ready: boolean }) {
  useEffect(() => {
    if (!ready) {
      return;
    }
    let active = true;
    const acknowledge = () => {
      Promise.resolve()
        .then(() => getUpdateStartupContext())
        .then((context) => {
          if (active && context) {
            return reportUpdateStartup(context.nonce, true);
          }
        })
        .catch(() => undefined);
    };
    const statusChanged = (event: MessageEvent) => {
      if (
        event.data?.channel === "update:status" &&
        event.data.phase === "confirming"
      ) {
        acknowledge();
      }
    };
    window.addEventListener("message", statusChanged);
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        acknowledge();
      });
    });
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      window.removeEventListener("message", statusChanged);
    };
  }, [ready]);
  return null;
}
