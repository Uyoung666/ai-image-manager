import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  type PluginManagerInstallPreview,
  type PluginManagerPlugin,
  PluginManagerView,
} from "@/components/plugins/plugin-manager-view";
import { PluginSettingsSlot, usePluginHost } from "@/plugins/runtime";

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error) {
    return error;
  }
  return fallback;
}

function PluginsSettingsPage() {
  const { t } = useTranslation();
  const {
    activePlugin,
    clearError,
    commitInstall,
    developerMode,
    discardInstall,
    disable,
    enable,
    error,
    exitPreview,
    inspectInstall,
    loading,
    loadDeveloperDirectory,
    plugins,
    previewId,
    previewPlugin,
    refresh,
    reloadDeveloperPlugin,
    removeDeveloperPlugin,
    selectedId,
    selectPlugin,
    setDeveloperMode,
    uninstall,
  } = usePluginHost();
  const [installPreview, setInstallPreview] =
    useState<PluginManagerInstallPreview | null>(null);
  const installPreviewRef = useRef<PluginManagerInstallPreview | null>(null);
  installPreviewRef.current = installPreview;

  const showError = useCallback(
    (reason: unknown) => {
      toast.error(errorMessage(reason, t("pluginManagerError")));
    },
    [t]
  );

  useEffect(() => {
    if (!error) {
      return;
    }
    showError(error);
    clearError();
  }, [clearError, error, showError]);

  useEffect(
    () => () => {
      exitPreview();
      const token = installPreviewRef.current?.token;
      if (token) {
        discardInstall(token).catch(() => undefined);
      }
    },
    [discardInstall, exitPreview]
  );

  const managerPlugins = useMemo(
    () => plugins as unknown as PluginManagerPlugin[],
    [plugins]
  );

  const run = (operation: () => Promise<void>) => {
    operation().catch(showError);
  };

  const beginInstall = () => {
    run(async () => {
      const result = await inspectInstall();
      if (!result) {
        return;
      }
      setInstallPreview(result);
    });
  };

  const cancelInstall = () => {
    const token = installPreview?.token;
    setInstallPreview(null);
    if (token) {
      run(() => discardInstall(token));
    }
  };

  const confirmInstall = (preview: PluginManagerInstallPreview) => {
    const token = preview.token;
    if (!token) {
      showError(t("pluginManagerInstallBlocked"));
      return;
    }
    run(async () => {
      await commitInstall(token);
      setInstallPreview(null);
    });
  };

  const settingsPanel = (
    <PluginSettingsSlot onError={showError} slot="plugin.settings" />
  );

  return (
    <div className="h-full min-w-0 overflow-y-auto overflow-x-hidden p-3 sm:p-6 min-[480px]:p-4">
      <div className="mx-auto w-full min-w-0 max-w-[1120px]">
        <PluginManagerView
          activeId={activePlugin?.manifest.id ?? null}
          developerMode={developerMode}
          installPreview={installPreview}
          loading={loading}
          onCancelInstall={cancelInstall}
          onConfirmInstall={confirmInstall}
          onDeveloperModeChange={(enabled) =>
            run(() => setDeveloperMode(enabled))
          }
          onExitPreview={exitPreview}
          onInstallPlugin={beginInstall}
          onLoadDeveloperDirectory={() => run(loadDeveloperDirectory)}
          onPreviewPlugin={previewPlugin}
          onRefresh={() => run(refresh)}
          onReloadDeveloperPlugin={(pluginId) =>
            run(() => reloadDeveloperPlugin(pluginId))
          }
          onRemoveDeveloperPlugin={(pluginId) =>
            run(() => removeDeveloperPlugin(pluginId))
          }
          onSelectPlugin={selectPlugin}
          onTogglePlugin={(pluginId, enabled) =>
            run(() => (enabled ? enable(pluginId) : disable(pluginId)))
          }
          onUninstallPlugin={(pluginId, removeData) =>
            run(() => uninstall(pluginId, removeData))
          }
          plugins={managerPlugins}
          previewId={previewId}
          selectedId={selectedId}
          settingsPanel={settingsPanel}
        />
      </div>
    </div>
  );
}

export const Route = createFileRoute("/settings/plugins")({
  component: PluginsSettingsPage,
});
