import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentTheme, type ThemeMode } from "@/actions/theme";
import LangToggle from "@/components/lang-toggle";
import ToggleTheme from "@/components/toggle-theme";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
import { ipc } from "@/ipc/manager";

const SIDEBAR_COLLAPSED_KEY = "sidebar_collapsed";

function AppearanceSettingsPage() {
  const { t } = useTranslation();
  const [themeMode, setThemeMode] = useState<ThemeMode>("dark");
  const [openAtLogin, setOpenAtLogin] = useState(false);
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
    ipc.client.settings.getOpenAtLogin({}).then((r: any) => {
      setOpenAtLogin(r?.openAtLogin ?? false);
    });
  }, []);

  function handleOpenAtLoginToggle() {
    const next = !openAtLogin;
    setOpenAtLogin(next);
    ipc.client.settings.setOpenAtLogin({ openAtLogin: next }).catch(() => {
      setOpenAtLogin(!next); // rollback on failure
    });
  }

  function handleSidebarCollapsedToggle() {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="h-full overflow-y-auto p-6" ref={scrollRef}>
      <section className="space-y-3">
        <h2 className="font-semibold text-[14px] text-foreground">
          {t("settingsAppearance")}
        </h2>
        <div className="rounded-[8px] border border-border bg-secondary p-4">
          {/* Theme */}
          <div className="flex items-center justify-between">
            <div>
              <span className="text-[13px] text-muted-foreground">
                {t("settingsTheme")}
              </span>
              <p className="mt-0.5 text-[11px] text-muted-foreground/70">
                {themeMode === "dark"
                  ? t("themeDark")
                  : themeMode === "light"
                    ? t("themeLight")
                    : t("themeSystem")}
              </p>
            </div>
            <ToggleTheme onChange={setThemeMode} />
          </div>

          {/* Language */}
          <div className="mt-3 flex items-center justify-between border-border border-t pt-3">
            <span className="text-[13px] text-muted-foreground">
              {t("settingsLanguage")}
            </span>
            <LangToggle />
          </div>

          {/* Open at login */}
          <div className="mt-3 flex items-center justify-between border-border border-t pt-3">
            <div>
              <span className="text-[13px] text-muted-foreground">
                {t("openAtLogin")}
              </span>
              <p className="mt-0.5 text-[11px] text-muted-foreground/70">
                {t("openAtLoginHint")}
              </p>
            </div>
            <button
              className={`h-5 w-9 rounded-full transition-colors ${
                openAtLogin ? "bg-primary" : "bg-muted"
              }`}
              onClick={handleOpenAtLoginToggle}
              type="button"
            >
              <div
                className={`h-4 w-4 rounded-full bg-white transition-transform ${
                  openAtLogin ? "translate-x-[18px]" : "translate-x-[2px]"
                }`}
              />
            </button>
          </div>

          {/* Sidebar default state */}
          <div className="mt-3 flex items-center justify-between border-border border-t pt-3">
            <div>
              <span className="text-[13px] text-muted-foreground">
                {t("sidebarDefaultCollapsed")}
              </span>
              <p className="mt-0.5 text-[11px] text-muted-foreground/70">
                {t("sidebarDefaultCollapsedHint")}
              </p>
            </div>
            <button
              className={`h-5 w-9 rounded-full transition-colors ${
                sidebarCollapsed ? "bg-primary" : "bg-muted"
              }`}
              onClick={handleSidebarCollapsedToggle}
              type="button"
            >
              <div
                className={`h-4 w-4 rounded-full bg-white transition-transform ${
                  sidebarCollapsed ? "translate-x-[18px]" : "translate-x-[2px]"
                }`}
              />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

export const Route = createFileRoute("/settings/appearance")({
  component: AppearanceSettingsPage,
});
