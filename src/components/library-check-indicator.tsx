import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { libraryReliabilityActions } from "@/actions/library-reliability";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ImportQueueStatus } from "@/services/import-queue";

/** A background source check never owns the foreground import progress bar. */
export function LibraryCheckIndicator() {
  const { t } = useTranslation();
  const [queue, setQueue] = useState<ImportQueueStatus | null>(null);
  const [visible, setVisible] = useState(false);
  const active = queue?.current?.source === "background";
  useEffect(() => {
    let alive = true;
    let received = false;
    const receive = (event: MessageEvent) => {
      if (event.data?.channel === "import-queue-status") {
        received = true;
        setQueue(event.data);
      }
    };
    window.addEventListener("message", receive);
    libraryReliabilityActions
      .getImportQueueStatus()
      .then((value) => {
        if (alive && !received) {
          setQueue(value);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      window.removeEventListener("message", receive);
    };
  }, []);
  useEffect(() => {
    const timer = setTimeout(
      () => setVisible(Boolean(active)),
      active ? 500 : 300
    );
    return () => clearTimeout(timer);
  }, [active]);
  if (!visible) {
    return null;
  }
  const folder =
    queue?.current?.folderPath.replace(/\\/g, "/").split("/").at(-1) ?? "";
  const label = t("libraryCheckDetails", {
    folder,
    count:
      queue?.pending.filter((task) => task.source === "background").length ?? 0,
  });
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Keyboard focus exposes the same status detail as hover. */}
        <span
          aria-label={label}
          className="no-drag mx-2 inline-flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground"
          data-testid="library-check-indicator"
          role="status"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard focus exposes background status details.
          tabIndex={0}
        >
          <LoadingSpinner aria-hidden="true" size="xs" variant="secondary" />
          <span className="hidden min-[841px]:inline">
            {t("libraryChecking")}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
