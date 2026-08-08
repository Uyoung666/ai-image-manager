import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentTheme, type ThemeMode } from "@/actions/theme";
import { setZoomFactor } from "@/actions/window";
import LangToggle from "@/components/lang-toggle";
import { SettingRow } from "@/components/settings/setting-row";
import {
  SettingsPageShell,
  SettingsSection,
} from "@/components/settings/settings-page-shell";
import ToggleTheme from "@/components/toggle-theme";
import { Switch } from "@/components/ui/switch";
import { useUiPreferences } from "@/hooks/use-reduced-motion";
import { ipc } from "@/ipc/manager";
import { cn } from "@/utils/tailwind";

const UI_SCALE_OPTIONS = [0.8, 0.9, 1.0, 1.1, 1.2, 1.3];

function getSettingValue(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const value = (result as { value?: unknown }).value;
  return typeof value === "string" ? value : undefined;
}

function UiScaleControl({
  value,
  onChange,
}: {
  value: number;
  onChange: (scale: number) => void;
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-[8px] bg-muted p-1">
      {UI_SCALE_OPTIONS.map((scale) => {
        const active = Math.abs(value - scale) < 0.001;
        return (
          <button
            aria-pressed={active}
            className={cn(
              "min-w-[44px] cursor-pointer select-none rounded-[6px] px-2 py-1.5 text-[12px] transition-all duration-150",
              active
                ? "bg-card font-semibold text-foreground shadow-[0_2px_8px_rgba(0,0,0,0.1)]"
                : "text-muted-foreground hover:bg-card/50"
            )}
            key={scale}
            onClick={() => onChange(scale)}
            type="button"
          >
            {Math.round(scale * 100)}%
          </button>
        );
      })}
    </div>
  );
}

const SENSITIVITY_OPTIONS: {
  descriptionKey: string;
  labelKey: string;
  value: string;
}[] = [
  {
    descriptionKey: "searchSensitivityRelaxedHint",
    labelKey: "searchSensitivityRelaxed",
    value: "relaxed",
  },
  {
    descriptionKey: "searchSensitivityStandardHint",
    labelKey: "searchSensitivityStandard",
    value: "standard",
  },
  {
    descriptionKey: "searchSensitivityStrictHint",
    labelKey: "searchSensitivityPrecise",
    value: "precise",
  },
];

function SensitivityControl({
  value,
  onChange,
}: {
  value: string;
  onChange: (preset: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center rounded-[8px] bg-muted p-1">
      {SENSITIVITY_OPTIONS.map((option) => {
        const active = value === option.value;
        return (
          <button
            aria-label={`${t(option.labelKey)}: ${t(option.descriptionKey)}`}
            aria-pressed={active}
            className={cn(
              "min-w-[52px] cursor-pointer select-none rounded-[6px] px-2 py-1.5 text-[12px] transition-all duration-150",
              active
                ? "bg-card font-semibold text-foreground shadow-[0_2px_8px_rgba(0,0,0,0.1)]"
                : "text-muted-foreground hover:bg-card/50"
            )}
            key={option.value}
            onClick={() => onChange(option.value)}
            title={t(option.descriptionKey)}
            type="button"
          >
            {t(option.labelKey)}
          </button>
        );
      })}
    </div>
  );
}

function AppearanceSettingsPage() {
  const { t } = useTranslation();
  const [themeMode, setThemeMode] = useState<ThemeMode>("dark");
  const { reduceMotion, setReduceMotion } = useUiPreferences();
  const [uiScale, setUiScale] = useState(1);
  const [searchSensitivity, setSearchSensitivity] = useState("standard");

  useEffect(() => {
    getCurrentTheme().then(setThemeMode);

    ipc.client.settings
      .getAppSetting({ key: "ui.zoomScale" })
      .then((result) => {
        const parsed = Number.parseFloat(getSettingValue(result) ?? "");
        if (Number.isFinite(parsed)) {
          setUiScale(parsed);
        }
      })
      .catch(() => undefined);

    ipc.client.settings
      .getAppSetting({ key: "search.sensitivity" })
      .then((result) => {
        const value = getSettingValue(result);
        if (
          value === "relaxed" ||
          value === "standard" ||
          value === "precise"
        ) {
          setSearchSensitivity(value);
        }
      })
      .catch(() => undefined);
  }, []);

  function onUiScaleChange(scale: number) {
    const previous = uiScale;
    setUiScale(scale);
    setZoomFactor(scale);
    ipc.client.settings
      .setAppSetting({ key: "ui.zoomScale", value: String(scale) })
      .catch(() => setUiScale(previous));
  }

  function onSensitivityChange(preset: string) {
    const previous = searchSensitivity;
    setSearchSensitivity(preset);
    ipc.client.settings
      .setAppSetting({ key: "search.sensitivity", value: preset })
      .catch(() => setSearchSensitivity(previous));
  }

  function onReduceMotionChange(checked: boolean) {
    setReduceMotion(checked).catch(() => undefined);
  }

  let themeDescription = t("themeSystem");
  if (themeMode === "dark") {
    themeDescription = t("themeDark");
  } else if (themeMode === "light") {
    themeDescription = t("themeLight");
  }

  return (
    <SettingsPageShell
      description={t("settingsAppearanceDescription")}
      title={t("settingsAppearance")}
    >
      <SettingsSection>
        <SettingRow
          action={<ToggleTheme onChange={setThemeMode} />}
          description={themeDescription}
          title={t("settingsTheme")}
        />
        <SettingRow
          action={<UiScaleControl onChange={onUiScaleChange} value={uiScale} />}
          description={t("settingsUiScaleHint")}
          title={t("settingsUiScale")}
        />
        <SettingRow action={<LangToggle />} title={t("settingsLanguage")} />
        <SettingRow
          action={
            <SensitivityControl
              onChange={onSensitivityChange}
              value={searchSensitivity}
            />
          }
          description={t("searchSensitivityHint")}
          title={t("settingsSearchSensitivity")}
        />
        <SettingRow
          action={
            <Switch
              checked={reduceMotion}
              onCheckedChange={onReduceMotionChange}
            />
          }
          description={t("settingsReduceMotionHint")}
          title={t("settingsReduceMotion")}
        />
      </SettingsSection>
    </SettingsPageShell>
  );
}

export const Route = createFileRoute("/settings/appearance")({
  component: AppearanceSettingsPage,
});
