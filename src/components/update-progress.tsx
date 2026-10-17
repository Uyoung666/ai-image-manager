import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { UpdateStatus } from "@/types/update";
import {
  formatUpdateBytes,
  updatePercent,
  updateRetrySeconds,
  updateStageKey,
} from "@/utils/update-presentation";

export function useUpdateNow(active: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) {
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function UpdateProgress({
  status,
  pendingInstall = false,
}: {
  status: UpdateStatus;
  pendingInstall?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const now = useUpdateNow(
    !["idle", "up-to-date", "downloaded", "error"].includes(status.phase)
  );
  const percent = updatePercent(status);
  const download =
    status.phase === "downloading" || status.phase === "retry-wait";
  const started = Date.parse(
    status.installStartedAt ?? status.phaseStartedAt ?? ""
  );
  const amount = formatUpdateBytes(status.transferred, i18n?.language);
  const total = formatUpdateBytes(status.total, i18n?.language);
  const speed =
    !status.networkWaiting &&
    status.phase !== "retry-wait" &&
    status.bytesPerSecond != null
      ? formatUpdateBytes(status.bytesPerSecond, i18n?.language)
      : "";
  const label = t(
    pendingInstall ? "updatePreparingInstall" : updateStageKey(status)
  );

  return (
    <div className="min-w-0 space-y-2" data-testid="update-progress">
      <div className="flex min-w-0 items-start gap-2">
        <LoadingSpinner size="sm" variant="secondary" />
        <p
          aria-atomic="true"
          aria-live="polite"
          className="min-w-0 text-[12px] [overflow-wrap:anywhere]"
          role="status"
        >
          {label}
        </p>
      </div>
      {download && (
        <div className="space-y-1.5">
          <div
            aria-label={t("updateProgressBar")}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={percent}
            className="h-1.5 overflow-hidden rounded-full bg-muted"
            data-reduced-motion-keep="progress-bar"
            role="progressbar"
          >
            <div
              className={`h-full rounded-full bg-primary ${percent == null ? "w-2/5 animate-indeterminate-bar" : "transition-[width] duration-200"}`}
              data-reduced-motion-keep="progress-bar"
              style={percent == null ? undefined : { width: `${percent}%` }}
            />
          </div>
          <div
            aria-live="off"
            className="flex min-w-0 flex-wrap justify-between gap-x-3 gap-y-1 text-[11px] text-muted-foreground tabular-nums"
          >
            <span>
              {[
                percent == null ? "" : `${percent}%`,
                amount && total ? `${amount} / ${total}` : amount || total,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
            {speed && <span>{t("updateSpeed", { speed })}</span>}
          </div>
        </div>
      )}
      <div
        aria-live="off"
        className="space-y-1 text-[11px] text-muted-foreground [overflow-wrap:anywhere]"
      >
        {status.phase === "retry-wait" && (
          <p>
            {t("updateRetryCountdown", {
              seconds: updateRetrySeconds(status, now),
              attempt: Math.min(
                status.maxAttempts ?? 4,
                (status.attempt ?? 1) + 1
              ),
              total: status.maxAttempts ?? 4,
            })}
          </p>
        )}
        {Number.isFinite(started) && !pendingInstall && (
          <p>
            {t("updateElapsed", {
              seconds: Math.max(0, Math.floor((now - started) / 1000)),
            })}
          </p>
        )}
      </div>
    </div>
  );
}
