import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingRow } from "@/components/settings/setting-row";
import {
  SettingsPageShell,
  SettingsSection,
} from "@/components/settings/settings-page-shell";
import { Switch } from "@/components/ui/switch";
import { ipc } from "@/ipc/manager";

const SIDEBAR_COLLAPSED_KEY = "sidebar_collapsed";
const CLOSE_BEHAVIOR_OPTIONS = ["tray", "quit", "ask"] as const;
type CloseBehavior = (typeof CLOSE_BEHAVIOR_OPTIONS)[number];
const CLOSE_BEHAVIOR_LABEL_KEYS: Record<CloseBehavior, string> = {
  ask: "settingsCloseBehaviorAsk",
  quit: "settingsCloseBehaviorQuit",
  tray: "settingsCloseBehaviorTray",
};

function getSettingValue(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const value = (result as { value?: unknown }).value;
  return typeof value === "string" ? value : undefined;
}

function getBooleanSetting(result: unknown, fallback: boolean): boolean {
  const value = getSettingValue(result);
  return value === undefined ? fallback : value === "true";
}

function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

function BehaviorSettingsPage() {
  const { t } = useTranslation();
  const [closeBehavior, setCloseBehavior] = useState<CloseBehavior>("tray");
  const [rememberBounds, setRememberBounds] = useState(false);
  const [openAtLogin, setOpenAtLogin] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] =
    useState(readSidebarCollapsed);
  const [syncCullFavorites, setSyncCullFavorites] = useState(true);

  useEffect(() => {
    ipc.client.settings
      .getAppPreferences({})
      .then((preferences) => {
        setCloseBehavior(preferences.closeBehavior);
        setRememberBounds(preferences.rememberBounds);
      })
      .catch(() => undefined);

    ipc.client.settings
      .getOpenAtLogin({})
      .then((result) => {
        setOpenAtLogin(
          (result as { openAtLogin?: boolean }).openAtLogin ?? false
        );
      })
      .catch(() => undefined);

    ipc.client.settings
      .getAppSetting({ key: "cull.syncKeptWithFavorites" })
      .then((result) => setSyncCullFavorites(getBooleanSetting(result, true)))
      .catch(() => undefined);
  }, []);

  function onCloseBehaviorChange(value: CloseBehavior) {
    const previous = closeBehavior;
    setCloseBehavior(value);
    ipc.client.settings
      .setAppPreference({ key: "window.closeBehavior", value })
      .catch(() => setCloseBehavior(previous));
  }

  function onRememberBoundsChange(checked: boolean) {
    const previous = rememberBounds;
    setRememberBounds(checked);
    ipc.client.settings
      .setAppPreference({
        key: "window.rememberBounds",
        value: String(checked),
      })
      .catch(() => setRememberBounds(previous));
  }

  function onOpenAtLoginChange(checked: boolean) {
    const previous = openAtLogin;
    setOpenAtLogin(checked);
    ipc.client.settings
      .setOpenAtLogin({ openAtLogin: checked })
      .catch(() => setOpenAtLogin(previous));
  }

  function onSidebarCollapsedChange(checked: boolean) {
    const previous = sidebarCollapsed;
    setSidebarCollapsed(checked);
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(checked));
    } catch {
      setSidebarCollapsed(previous);
    }
  }

  function onSyncCullFavoritesChange(checked: boolean) {
    const previous = syncCullFavorites;
    setSyncCullFavorites(checked);
    ipc.client.settings
      .setAppSetting({
        key: "cull.syncKeptWithFavorites",
        value: String(checked),
      })
      .catch(() => setSyncCullFavorites(previous));
  }

  return (
    <SettingsPageShell
      description={t("settingsBehaviorDescription")}
      title={t("settingsBehavior")}
    >
      <SettingsSection>
        <SettingRow
          action={
            <select
              aria-label={t("settingsCloseBehavior")}
              className="h-8 min-w-[160px] rounded-[6px] border border-input bg-card px-2 text-[12px] text-foreground outline-none focus:border-primary"
              onChange={(event) =>
                onCloseBehaviorChange(event.target.value as CloseBehavior)
              }
              value={closeBehavior}
            >
              {CLOSE_BEHAVIOR_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {t(CLOSE_BEHAVIOR_LABEL_KEYS[value])}
                </option>
              ))}
            </select>
          }
          description={t("settingsCloseBehaviorHint")}
          title={t("settingsCloseBehavior")}
        />
        <SettingRow
          action={
            <Switch
              checked={rememberBounds}
              onCheckedChange={onRememberBoundsChange}
            />
          }
          description={t("settingsRememberWindowBoundsHint")}
          title={t("settingsRememberWindowBounds")}
        />
        <SettingRow
          action={
            <Switch
              checked={openAtLogin}
              onCheckedChange={onOpenAtLoginChange}
            />
          }
          description={t("openAtLoginHint")}
          title={t("openAtLogin")}
        />
        <SettingRow
          action={
            <Switch
              checked={sidebarCollapsed}
              onCheckedChange={onSidebarCollapsedChange}
            />
          }
          description={t("sidebarDefaultCollapsedHint")}
          title={t("sidebarDefaultCollapsed")}
        />
        <SettingRow
          action={
            <Switch
              checked={syncCullFavorites}
              onCheckedChange={onSyncCullFavoritesChange}
            />
          }
          description={t("cullSyncFavoritesHint")}
          title={t("cullSyncFavorites")}
        />
      </SettingsSection>
    </SettingsPageShell>
  );
}

export const Route = createFileRoute("/settings/behavior")({
  component: BehaviorSettingsPage,
});
