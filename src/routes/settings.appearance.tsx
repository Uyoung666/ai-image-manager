import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentTheme, type ThemeMode } from "@/actions/theme";
import LangToggle from "@/components/lang-toggle";
import { SettingRow } from "@/components/settings/setting-row";
import ToggleTheme from "@/components/toggle-theme";
import { Switch } from "@/components/ui/switch";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
import { ipc } from "@/ipc/manager";

const SIDEBAR_COLLAPSED_KEY = "sidebar_collapsed";

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
  }, []);

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
