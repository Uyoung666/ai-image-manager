import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FilterDropdown } from "@/components/filter-dropdown";
import { SettingRow } from "@/components/settings/setting-row";
import {
  SettingsPageShell,
  SettingsSection,
} from "@/components/settings/settings-page-shell";
import { Switch } from "@/components/ui/switch";
import { ipc } from "@/ipc/manager";
import {
  createOptimisticSaveQueue,
  type OptimisticSaveQueue,
} from "@/utils/optimistic-save-queue";

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
  const closeBehaviorQueueRef =
    useRef<OptimisticSaveQueue<CloseBehavior> | null>(null);
  const rememberBoundsQueueRef = useRef<OptimisticSaveQueue<boolean> | null>(
    null
  );
  const openAtLoginQueueRef = useRef<OptimisticSaveQueue<boolean> | null>(null);
  const syncCullFavoritesQueueRef = useRef<OptimisticSaveQueue<boolean> | null>(
    null
  );

  if (!closeBehaviorQueueRef.current) {
    closeBehaviorQueueRef.current = createOptimisticSaveQueue({
      initialValue: "tray" as CloseBehavior,
      onRollback: (value) => setCloseBehavior(value),
      onSaveError: () => toast.error(t("saveFailed")),
      persist: (value) =>
        ipc.client.settings.setAppPreference({
          key: "window.closeBehavior",
          value,
        }),
    });
  }

  if (!rememberBoundsQueueRef.current) {
    rememberBoundsQueueRef.current = createOptimisticSaveQueue({
      initialValue: false,
      onRollback: (value) => setRememberBounds(value),
      onSaveError: () => toast.error(t("saveFailed")),
      persist: (value) =>
        ipc.client.settings.setAppPreference({
          key: "window.rememberBounds",
          value: String(value),
        }),
    });
  }

  if (!openAtLoginQueueRef.current) {
    openAtLoginQueueRef.current = createOptimisticSaveQueue({
      initialValue: false,
      onRollback: (value) => setOpenAtLogin(value),
      onSaveError: () => toast.error(t("saveFailed")),
      persist: (value) =>
        ipc.client.settings.setOpenAtLogin({ openAtLogin: value }),
    });
  }

  if (!syncCullFavoritesQueueRef.current) {
    syncCullFavoritesQueueRef.current = createOptimisticSaveQueue({
      initialValue: true,
      onRollback: (value) => setSyncCullFavorites(value),
      onSaveError: () => toast.error(t("saveFailed")),
      persist: (value) =>
        ipc.client.settings.setAppSetting({
          key: "cull.syncKeptWithFavorites",
          value: String(value),
        }),
    });
  }

  const hydrateCloseBehavior = useCallback((value: CloseBehavior) => {
    if (!closeBehaviorQueueRef.current?.hydrate(value)) {
      return;
    }
    setCloseBehavior(value);
  }, []);

  const hydrateRememberBounds = useCallback((value: boolean) => {
    if (!rememberBoundsQueueRef.current?.hydrate(value)) {
      return;
    }
    setRememberBounds(value);
  }, []);

  const hydrateOpenAtLogin = useCallback((value: boolean) => {
    if (!openAtLoginQueueRef.current?.hydrate(value)) {
      return;
    }
    setOpenAtLogin(value);
  }, []);

  const hydrateSyncCullFavorites = useCallback((value: boolean) => {
    if (!syncCullFavoritesQueueRef.current?.hydrate(value)) {
      return;
    }
    setSyncCullFavorites(value);
  }, []);

  useEffect(() => {
    ipc.client.settings
      .getAppPreferences({})
      .then((preferences) => {
        hydrateCloseBehavior(preferences.closeBehavior);
        hydrateRememberBounds(preferences.rememberBounds);
      })
      .catch(() => {
        hydrateCloseBehavior("tray");
        hydrateRememberBounds(false);
      });

    ipc.client.settings
      .getOpenAtLogin({})
      .then((result) => {
        const value =
          (result as { openAtLogin?: boolean }).openAtLogin ?? false;
        hydrateOpenAtLogin(value);
      })
      .catch(() => hydrateOpenAtLogin(false));

    ipc.client.settings
      .getAppSetting({ key: "cull.syncKeptWithFavorites" })
      .then((result) => {
        const value = getBooleanSetting(result, true);
        hydrateSyncCullFavorites(value);
      })
      .catch(() => hydrateSyncCullFavorites(true));
  }, [
    hydrateCloseBehavior,
    hydrateOpenAtLogin,
    hydrateRememberBounds,
    hydrateSyncCullFavorites,
  ]);

  function onCloseBehaviorChange(value: CloseBehavior) {
    setCloseBehavior(value);
    closeBehaviorQueueRef.current?.enqueue(value);
  }

  function onRememberBoundsChange(checked: boolean) {
    setRememberBounds(checked);
    rememberBoundsQueueRef.current?.enqueue(checked);
  }

  function onOpenAtLoginChange(checked: boolean) {
    setOpenAtLogin(checked);
    openAtLoginQueueRef.current?.enqueue(checked);
  }

  function onSidebarCollapsedChange(checked: boolean) {
    const previous = sidebarCollapsed;
    setSidebarCollapsed(checked);
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(checked));
    } catch {
      setSidebarCollapsed(previous);
      toast.error(t("saveFailed"));
    }
  }

  function onSyncCullFavoritesChange(checked: boolean) {
    setSyncCullFavorites(checked);
    syncCullFavoritesQueueRef.current?.enqueue(checked);
  }

  return (
    <SettingsPageShell
      description={t("settingsBehaviorDescription")}
      title={t("settingsBehavior")}
    >
      <SettingsSection>
        <SettingRow
          action={
            <FilterDropdown
              ariaLabel={t("settingsCloseBehavior")}
              className="w-full min-w-0 max-w-[220px]"
              onChange={(value) =>
                onCloseBehaviorChange(value as CloseBehavior)
              }
              options={CLOSE_BEHAVIOR_OPTIONS.map((value) => ({
                label: t(CLOSE_BEHAVIOR_LABEL_KEYS[value]),
                value,
              }))}
              placeholder={t("settingsCloseBehavior")}
              value={closeBehavior}
            />
          }
          description={t("settingsCloseBehaviorHint")}
          title={t("settingsCloseBehavior")}
        />
        <SettingRow
          action={
            <Switch
              ariaLabel={t("settingsRememberWindowBounds")}
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
              ariaLabel={t("openAtLogin")}
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
              ariaLabel={t("sidebarDefaultCollapsed")}
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
              ariaLabel={t("cullSyncFavorites")}
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
