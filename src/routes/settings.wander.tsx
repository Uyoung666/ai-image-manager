import { createFileRoute } from "@tanstack/react-router";
import { Compass } from "lucide-react";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { FilterDropdown } from "@/components/filter-dropdown";
import { SettingRow } from "@/components/settings/setting-row";
import { SettingsPageShell } from "@/components/settings/settings-page-shell";
import { Switch } from "@/components/ui/switch";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
import { useWander } from "@/providers/WanderProvider";
import type { WanderContentMode, WanderSettings } from "@/types/wander";

const IDLE_OPTIONS: WanderSettings["idleMinutes"][] = [10, 15, 30];
const INTERVAL_OPTIONS: WanderSettings["intervalSeconds"][] = [3, 5, 10];
const CONTENT_MODES: WanderContentMode[] = [
  "timeCapsule",
  "theme",
  "rediscovery",
  "hamsterWheel",
];

function WanderSettingsPage() {
  const { t } = useTranslation();
  const {
    active: wanderActive,
    loading: wanderLoading,
    preferences,
    startError,
    start: startWander,
    updatePreference,
  } = useWander();
  const scrollRef = useRef<HTMLDivElement>(null);
  useRouteScrollRestoration(scrollRef);

  const toggleMode = (mode: WanderContentMode, checked: boolean) => {
    const next = checked
      ? [...new Set([...preferences.modes, mode])]
      : preferences.modes.filter((item) => item !== mode);
    if (next.length > 0) {
      updatePreference("modes", next).catch(() => undefined);
    }
  };

  return (
    <SettingsPageShell
      description={t("wander.startHint")}
      scrollRef={scrollRef}
      title={t("settingsWander")}
    >
      <button
        className="inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-md bg-primary px-4 py-2 font-medium text-[13px] text-primary-foreground [overflow-wrap:anywhere] hover:bg-primary/90 disabled:opacity-50"
        disabled={wanderActive || wanderLoading}
        onClick={() => startWander()}
        type="button"
      >
        <Compass className="h-4 w-4" />
        {t("wander.startNow")}
      </button>
      {startError && (
        <p
          aria-live="polite"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive"
          role="alert"
        >
          {t(`wander.${startError}`)}
        </p>
      )}

      <div className="min-w-0 rounded-[8px] border border-border bg-secondary p-3 min-[480px]:p-4">
        <SettingRow
          action={
            <Switch
              ariaLabel={t("wander.enabled")}
              checked={preferences.enabled}
              onCheckedChange={(checked) =>
                updatePreference("enabled", checked).catch(() => undefined)
              }
            />
          }
          description={t("wander.enabledHint")}
          title={t("wander.enabled")}
        />
        <SettingRow
          action={
            <FilterDropdown
              ariaLabel={t("wander.idleMinutes")}
              className="max-w-full"
              onChange={(value) =>
                updatePreference(
                  "idleMinutes",
                  Number(value) as WanderSettings["idleMinutes"]
                ).catch(() => undefined)
              }
              options={IDLE_OPTIONS.map((value) => ({
                label: t("wander.minutes", { count: value }),
                value: String(value),
              }))}
              placeholder={t("wander.idleMinutes")}
              value={String(preferences.idleMinutes)}
            />
          }
          description={t("wander.idleMinutesHint")}
          title={t("wander.idleMinutes")}
        />
        <SettingRow
          action={
            <FilterDropdown
              ariaLabel={t("wander.intervalSeconds")}
              className="max-w-full"
              onChange={(value) =>
                updatePreference(
                  "intervalSeconds",
                  Number(value) as WanderSettings["intervalSeconds"]
                ).catch(() => undefined)
              }
              options={INTERVAL_OPTIONS.map((value) => ({
                label: t("wander.seconds", { count: value }),
                value: String(value),
              }))}
              placeholder={t("wander.intervalSeconds")}
              value={String(preferences.intervalSeconds)}
            />
          }
          description={t("wander.intervalSecondsHint")}
          title={t("wander.intervalSeconds")}
        />
      </div>

      <div className="min-w-0 rounded-[8px] border border-border bg-secondary p-3 min-[480px]:p-4">
        <div className="pb-2">
          <div className="font-medium text-[13px] text-foreground">
            {t("wander.contentMode")}
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
            {t("wander.contentModeHint")}
          </div>
        </div>
        {CONTENT_MODES.map((mode) => (
          <SettingRow
            action={
              <Switch
                ariaLabel={t(`wander.mode.${mode}`)}
                checked={preferences.modes.includes(mode)}
                disabled={
                  preferences.modes.length === 1 &&
                  preferences.modes.includes(mode)
                }
                onCheckedChange={(checked) => toggleMode(mode, checked)}
              />
            }
            key={mode}
            title={t(`wander.mode.${mode}`)}
          />
        ))}
      </div>
    </SettingsPageShell>
  );
}

export const Route = createFileRoute("/settings/wander")({
  component: WanderSettingsPage,
});
