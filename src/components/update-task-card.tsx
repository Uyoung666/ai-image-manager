import { CheckCircle2, ChevronDown, XCircle } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { UpdateProgress, useUpdateNow } from "@/components/update-progress";
import { useUpdateUi, useUpdateUiActions } from "@/hooks/use-update-ui";
import { UPDATE_ERROR_KEYS } from "@/types/update";
import { classifyUpdateError } from "@/utils/update-error";
import {
  canOfferFullUpdate,
  isUpdateBusy,
  isUpdateReady,
  updatePrimaryAction,
  updateReasonKey,
  updateRetrySeconds,
} from "@/utils/update-presentation";

const SECONDARY_BUTTON =
  "inline-flex min-h-8 max-w-full items-center justify-center rounded-md border border-input px-3 py-1.5 text-[12px] text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 [overflow-wrap:anywhere]";

function useUpdateTaskView(appVersion?: string) {
  const snapshot = useUpdateUi((state) => ({
    status: state.status,
    currentVersion: state.appVersion,
    pending: state.pending,
    commandError: state.commandError,
    statusError: state.statusError,
    failedCommand: state.failedCommand,
  }));
  const { status, pending, commandError, failedCommand } = snapshot;
  const now = useUpdateNow(
    Boolean(status.retryAfter) && status.phase === "error"
  );
  const error =
    commandError ??
    snapshot.statusError ??
    (status.phase === "error"
      ? classifyUpdateError(status.message)
      : undefined);
  let primary = updatePrimaryAction(status);
  if (commandError && failedCommand && failedCommand !== "manual") {
    primary = {
      command: failedCommand,
      label: failedCommand === "install" ? "updateRetryUpdate" : "updateRetry",
    };
  }
  const preparingInstall = pending === "install" && !isUpdateBusy(status);
  return {
    ...snapshot,
    primary,
    error,
    preparingInstall,
    version:
      appVersion || snapshot.currentVersion || status.sourceVersion || "…",
    cooldown: status.phase === "error" ? updateRetrySeconds(status, now) : 0,
    ready: isUpdateReady(status) && !preparingInstall,
    busy:
      isUpdateBusy(status) ||
      Boolean(status.resumeInstallation && status.phase === "downloaded"),
    reason: updateReasonKey(status),
  };
}
type UpdateTaskView = ReturnType<typeof useUpdateTaskView>;

function UpdateVersion({ view }: { view: UpdateTaskView }) {
  const { t } = useTranslation();
  const { status, version } = view;
  return (
    <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
      <p className="min-w-0 text-[12px] text-muted-foreground [overflow-wrap:anywhere]">
        {t("updateStatusIdle", { version })}
        {status.version && status.version !== version && (
          <span className="font-medium text-foreground">{` → ${status.version}`}</span>
        )}
      </p>
      {status.updateMethod && (
        <span className="rounded bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
          {t(
            status.updateMethod === "delta"
              ? "updateDeltaPackage"
              : "updateFullPackage"
          )}
        </span>
      )}
    </div>
  );
}

function UpdateTaskStatus({ view }: { view: UpdateTaskView }) {
  const { t, i18n } = useTranslation();
  const { status, busy, preparingInstall, ready, reason, error, cooldown } =
    view;
  return (
    <>
      {(busy || preparingInstall) && (
        <UpdateProgress pendingInstall={preparingInstall} status={status} />
      )}
      {ready && (
        <p
          aria-live="polite"
          className="flex min-w-0 items-start gap-2 font-medium text-[12px] [overflow-wrap:anywhere]"
          role="status"
        >
          <CheckCircle2
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-primary"
          />
          {t("updateDownloadedStatus", { version: status.version })}
        </p>
      )}
      {reason && (
        <p className="text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
          {t(reason)}
        </p>
      )}
      {error && (
        <div
          className="flex min-w-0 items-start gap-2 rounded-md border border-destructive/25 bg-destructive/5 p-2.5"
          role="alert"
        >
          <XCircle
            aria-hidden="true"
            className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
          />
          <p className="min-w-0 text-[12px] text-destructive [overflow-wrap:anywhere]">
            {t(UPDATE_ERROR_KEYS[error])}
          </p>
        </div>
      )}
      {status.phase === "up-to-date" && (
        <p
          aria-live="polite"
          className="text-[12px] text-muted-foreground"
          role="status"
        >
          {t("updateUpToDate")}
        </p>
      )}
      {status.lastCheckedAt && (
        <p className="text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
          {t("updateLastCheck", {
            time: new Date(status.lastCheckedAt).toLocaleString(i18n?.language),
          })}
        </p>
      )}
      {cooldown > 0 && (
        <p aria-live="off" className="text-[11px] text-muted-foreground">
          {t("updateRetryAvailableIn", { seconds: cooldown })}
        </p>
      )}
      {ready && (
        <p className="text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
          {t("updateInstallRestartHint")}
        </p>
      )}
    </>
  );
}

function UpdateTaskActions({ view }: { view: UpdateTaskView }) {
  const { t } = useTranslation();
  const actions = useUpdateUiActions();
  const { status, primary, pending, cooldown, error } = view;
  let primaryLabel = primary?.label ?? "updateRequestPending";
  if (pending) {
    primaryLabel =
      pending === "install" ? "updatePreparingInstall" : "updateRequestPending";
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {primary && (
        <button
          className="inline-flex min-h-8 max-w-full items-center justify-center rounded-md bg-primary px-3 py-1.5 text-[12px] text-primary-foreground transition-colors [overflow-wrap:anywhere] hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={Boolean(pending) || cooldown > 0}
          onClick={() => actions.run(primary.command)}
          type="button"
        >
          {t(primaryLabel)}
        </button>
      )}
      {canOfferFullUpdate(status) && (
        <button
          className={SECONDARY_BUTTON}
          disabled={Boolean(pending) || cooldown > 0}
          onClick={() => actions.run("full")}
          type="button"
        >
          {t("updateUseFull")}
        </button>
      )}
      {(status.phase === "error" || error || view.ready) && (
        <button
          className={SECONDARY_BUTTON}
          disabled={Boolean(pending)}
          onClick={() => actions.run("manual")}
          type="button"
        >
          {t("updateDownloadManually")}
        </button>
      )}
    </div>
  );
}

function UpdateReleaseNotes({ notes }: { notes: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState({ notes, open: false });
  const open = expanded.notes === notes && expanded.open;
  return (
    <div className="min-w-0 border-border border-t pt-2">
      <button
        aria-expanded={open}
        className="flex min-h-8 max-w-full items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground"
        onClick={() => setExpanded({ notes, open: !open })}
        type="button"
      >
        <ChevronDown
          aria-hidden="true"
          className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
        />
        {t("updateReleaseNotes")}
      </button>
      {open && (
        <p className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-background p-2 text-[12px] text-muted-foreground [overflow-wrap:anywhere]">
          {notes}
        </p>
      )}
    </div>
  );
}

export function UpdateTaskCard({
  appVersion,
  compact = false,
}: {
  appVersion?: string;
  compact?: boolean;
}) {
  const view = useUpdateTaskView(appVersion);
  return (
    <div className="min-w-0 space-y-3" data-testid="update-task-card">
      <UpdateVersion view={view} />
      <UpdateTaskStatus view={view} />
      <UpdateTaskActions view={view} />
      {!compact && view.status.releaseNotes && (
        <UpdateReleaseNotes
          key={view.status.version}
          notes={view.status.releaseNotes}
        />
      )}
    </div>
  );
}
