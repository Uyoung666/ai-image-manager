import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentTheme, type ThemeMode } from "@/actions/theme";
import { setZoomFactor } from "@/actions/window";
import LangToggle from "@/components/lang-toggle";
import { SettingRow } from "@/components/settings/setting-row";
import ToggleTheme from "@/components/toggle-theme";
import { Switch } from "@/components/ui/switch";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
import { ipc } from "@/ipc/manager";
import { cn } from "@/utils/tailwind";

const SIDEBAR_COLLAPSED_KEY = "sidebar_collapsed";

const UI_SCALE_OPTIONS = [0.8, 0.9, 1.0, 1.1, 1.2, 1.3];

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

function AppearanceSettingsPage() {
  const { t } = useTranslation();
  const [themeMode, setThemeMode] = useState<ThemeMode>("dark");
  const [openAtLogin, setOpenAtLogin] = useState(false);
  const [syncCullFavorites, setSyncCullFavorites] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [uiScale, setUiScale] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  useRouteScrollRestoration(scrollRef);

  useEffect(() => {
    getCurrentTheme().then(setThemeMode);
    ipc.client.settings.getOpenAtLogin({}).then((result) => {
      setOpenAtLogin(
        (result as { openAtLogin?: boolean }).openAtLogin ?? false
      );
    });
    ipc.client.settings
      .getAppSetting({ key: "cull.syncKeptWithFavorites" })
      .then((result) => {
        setSyncCullFavorites(
          (result as { value?: string | null }).value !== "false"
        );
      });
    ipc.client.settings
      .getAppSetting({ key: "ui.zoomScale" })
      .then((result) => {
        const raw = (result as { value?: string | null }).value;
        const parsed = Number.parseFloat(raw ?? "");
        if (Number.isFinite(parsed)) {
          setUiScale(parsed);
        }
      })
      .catch(() => undefined);
  }, []);

  function onUiScaleChange(scale: number) {
    setUiScale(scale);
    setZoomFactor(scale);
    ipc.client.settings
      .setAppSetting({ key: "ui.zoomScale", value: String(scale) })
      .catch(() => setUiScale(uiScale));
  }

  let themeDescription = t("themeSystem");
  if (themeMode === "dark") {
    themeDescription = t("themeDark");
  } else if (themeMode === "light") {
    themeDescription = t("themeLight");
  }

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6" ref={scrollRef}>
      <section className="mx-auto w-full max-w-[820px] space-y-3">
        <h2 className="font-semibold text-[14px] text-foreground">
          {t("settingsAppearance")}
        </h2>
        <div className="rounded-[8px] border border-border bg-secondary p-4">
          <SettingRow
            action={<ToggleTheme onChange={setThemeMode} />}
            description={themeDescription}
            title={t("settingsTheme")}
          />
          <SettingRow
            action={
              <UiScaleControl onChange={onUiScaleChange} value={uiScale} />
            }
            description={t("settingsUiScaleHint")}
            title={t("settingsUiScale")}
          />
          <SettingRow action={<LangToggle />} title={t("settingsLanguage")} />
          <SettingRow
            action={
              <Switch
                checked={openAtLogin}
                onCheckedChange={() => {
                  const next = !openAtLogin;
                  setOpenAtLogin(next);
                  ipc.client.settings
                    .setOpenAtLogin({ openAtLogin: next })
                    .catch(() => setOpenAtLogin(!next));
                }}
              />
            }
            description={t("openAtLoginHint")}
            title={t("openAtLogin")}
          />
          <SettingRow
            action={
              <Switch
                checked={sidebarCollapsed}
                onCheckedChange={() => {
                  const next = !sidebarCollapsed;
                  setSidebarCollapsed(next);
                  try {
                    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
                  } catch {
                    // Keep the in-memory preference when storage is unavailable.
                  }
                }}
              />
            }
            description={t("sidebarDefaultCollapsedHint")}
            title={t("sidebarDefaultCollapsed")}
          />
          <SettingRow
            action={
              <Switch
                checked={syncCullFavorites}
                onCheckedChange={() => {
                  const next = !syncCullFavorites;
                  setSyncCullFavorites(next);
                  ipc.client.settings
                    .setAppSetting({
                      key: "cull.syncKeptWithFavorites",
                      value: String(next),
                    })
                    .catch(() => setSyncCullFavorites(!next));
                }}
              />
            }
            description={t("cullSyncFavoritesHint")}
            title={t("cullSyncFavorites")}
          />
        </div>
      </section>
    </div>
  );
}

export const Route = createFileRoute("/settings/appearance")({
  component: AppearanceSettingsPage,
});
