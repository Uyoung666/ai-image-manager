import { useTranslation } from "react-i18next";
import { SettingRow } from "@/components/settings/setting-row";
import { Switch } from "@/components/ui/switch";
import { UpdateTaskCard } from "@/components/update-task-card";
import { useUpdateUi, useUpdateUiActions } from "@/hooks/use-update-ui";

export function UpdateSection({ appVersion }: { appVersion: string }) {
  const { t } = useTranslation();
  const actions = useUpdateUiActions();
  const preferences = useUpdateUi((state) => ({
    autoUpdate: state.autoUpdate,
    reminder: state.reminder,
    ready: state.preferencesReady,
    pending: state.preferencesPending,
    error: state.preferenceError,
  }));
  return (
    <section className="min-w-0 space-y-3">
      <div>
        <h2 className="font-semibold text-[14px] text-foreground">
          {t("settingsUpdate")}
        </h2>
        <p className="mt-1 text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
          {t("settingsUpdateDescription")}
        </p>
      </div>
      <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-secondary">
        <div className="p-3 min-[480px]:p-4">
          <UpdateTaskCard appVersion={appVersion} />
        </div>
        <div className="space-y-1 border-border border-t p-3 min-[480px]:p-4">
          <SettingRow
            action={
              <Switch
                ariaLabel={t("settingsAutoUpdate")}
                checked={preferences.autoUpdate}
                disabled={!preferences.ready || preferences.pending}
                onCheckedChange={(value) =>
                  actions.setPreference("autoUpdate", value)
                }
              />
            }
            description={t("settingsAutoUpdateHint")}
            title={t("settingsAutoUpdate")}
          />
          <SettingRow
            action={
              <Switch
                ariaLabel={t("settingsUpdateReminder")}
                checked={preferences.reminder}
                disabled={!preferences.ready || preferences.pending}
                onCheckedChange={(value) =>
                  actions.setPreference("reminder", value)
                }
              />
            }
            description={t("settingsUpdateReminderHint")}
            title={t("settingsUpdateReminder")}
          />
          {preferences.error && (
            <p
              className="text-[12px] text-destructive [overflow-wrap:anywhere]"
              role="alert"
            >
              {t("updatePreferenceSaveFailed")}
            </p>
          )}
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
        {t("updateProxySystemHint")}
      </p>
    </section>
  );
}
