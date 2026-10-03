import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { UpdateStatus } from "@/types/update";
import { UPDATE_ERROR_KEYS } from "@/types/update";

export function UpdateProgress({ status }: { status: UpdateStatus }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const started = Date.parse(
    status.installStartedAt ?? status.phaseStartedAt ?? ""
  );
  let label = t("updateInstalling");
  if (status.phase === "restarting") {
    label = t("updateRestarting");
  }
  if (status.phase === "recovering") {
    label = t("updateRecovering");
  }
  if (status.phase === "downloading") {
    label = t(
      status.networkWaiting ? "updateNetworkWaiting" : "updateDownloading"
    );
  }
  if (status.phase === "retry-wait") {
    label = t("updateRetryCountdown", {
      attempt: (status.attempt ?? 1) + 1,
      total: status.maxAttempts ?? 4,
      seconds:
        Math.max(
          0,
          Math.ceil((Date.parse(status.retryAfter ?? "") - now) / 1000)
        ) || 0,
    });
  }
  return (
    <div
      aria-live="polite"
      className="flex min-w-0 items-start gap-2"
      data-testid="update-progress"
    >
      <LoadingSpinner size="sm" variant="secondary" />
      <div className="min-w-0 text-[12px] [overflow-wrap:anywhere]">
        <p>{label}</p>
        {status.phase === "retry-wait" && status.message && (
          <p className="mt-1 text-muted-foreground">
            {t(UPDATE_ERROR_KEYS[status.message])}
          </p>
        )}
        {Number.isFinite(started) && (
          <p className="mt-1 text-muted-foreground">
            {t("updateElapsed", {
              seconds: Math.max(0, Math.floor((now - started) / 1000)),
            })}
          </p>
        )}
      </div>
    </div>
  );
}
