import { useNavigate } from "@tanstack/react-router";
import { CircleAlert, CircleCheck, Download, RefreshCw } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UpdateTaskCard } from "@/components/update-task-card";
import { useUpdateUi, useUpdateUiActions } from "@/hooks/use-update-ui";
import {
  isUpdateReady,
  updatePercent,
  updateShortStageKey,
  updateStageKey,
} from "@/utils/update-presentation";

function updateIcon(view: {
  error: boolean;
  ready: boolean;
  installing: boolean;
}) {
  if (view.error) {
    return CircleAlert;
  }
  if (view.ready) {
    return CircleCheck;
  }
  return view.installing ? RefreshCw : Download;
}

export function UpdateHeaderControl() {
  const titleId = useId();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const actions = useUpdateUiActions();
  const view = useUpdateUi((state) => ({
    open: state.detailsOpen,
    visible:
      !["idle", "up-to-date"].includes(state.status.phase) ||
      Boolean(state.commandError || state.statusError),
    ready: isUpdateReady(state.status) && state.pending !== "install",
    error:
      state.status.phase === "error" ||
      Boolean(state.commandError || state.statusError),
    stage:
      state.pending === "install" && state.status.phase === "downloaded"
        ? "updatePreparingInstall"
        : updateStageKey(state.status),
    shortStage:
      state.pending === "install" && state.status.phase === "downloaded"
        ? "updateInstallingShort"
        : updateShortStageKey(state.status),
    percent: updatePercent(state.status),
    version: state.status.version,
    installing:
      state.status.phase === "installing" ||
      state.status.phase === "restarting" ||
      state.pending === "install",
  }));
  if (!(view.visible || view.open)) {
    return null;
  }
  const label = [
    t(view.error ? "updateNeedsAttention" : view.stage),
    view.version,
    view.percent == null ? "" : `${view.percent}%`,
  ]
    .filter(Boolean)
    .join(" · ");
  const Icon = updateIcon(view);
  return (
    <Popover onOpenChange={actions.setDetailsOpen} open={view.open}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              aria-label={label}
              className={`no-drag my-0.5 mr-2 inline-flex min-h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring ${view.error ? "text-destructive" : "text-muted-foreground"}`}
              data-testid="update-header-control"
              type="button"
            >
              <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              <span className="hidden min-[841px]:inline">
                {t(view.error ? "updateNeedsAttention" : view.shortStage)}
              </span>
              {view.percent != null && (
                <span className="tabular-nums">{view.percent}%</span>
              )}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        aria-labelledby={titleId}
        className="window-buttons no-drag max-h-[min(70dvh,var(--radix-popover-content-available-height))] w-[360px] max-w-[calc(100dvw-24px)] gap-3 overflow-y-auto p-4"
        collisionPadding={12}
        data-testid="update-details"
        side="bottom"
        sideOffset={8}
      >
        <h2 className="font-semibold text-[14px]" id={titleId}>
          {t("settingsUpdate")}
        </h2>
        <UpdateTaskCard compact />
        <button
          className="min-h-8 self-start text-[12px] text-primary underline-offset-4 hover:underline"
          onClick={() => {
            actions.setDetailsOpen(false);
            navigate({ to: "/settings/update" });
          }}
          type="button"
        >
          {t("updateViewSettings")}
        </button>
      </PopoverContent>
    </Popover>
  );
}
