import { createFileRoute } from "@tanstack/react-router";
import { Download, PackageOpen, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SettingRow } from "@/components/settings/setting-row";
import {
  SettingsPageShell,
  SettingsSection,
} from "@/components/settings/settings-page-shell";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getLocalizedText } from "@/plugins/manifest";
import { PluginSettingsSlot, usePluginHost } from "@/plugins/runtime";

function PluginsSettingsPage() {
  const { i18n, t } = useTranslation();
  const {
    activePlugin,
    disable,
    enable,
    install,
    loading,
    plugins,
    uninstall,
  } = usePluginHost();
  const activePluginName = activePlugin
    ? getLocalizedText(activePlugin.manifest.name, i18n.language)
    : "";
  return (
    <SettingsPageShell
      description={t("settingsPluginsDescription")}
      headerAction={
        <Button
          disabled={loading}
          onClick={() => {
            install().catch(() => undefined);
          }}
          size="sm"
          variant="outline"
        >
          <Download />
          {t("settingsPluginsInstall")}
        </Button>
      }
      title={t("settingsPlugins")}
    >
      <SettingsSection
        description={t("settingsPluginsSafety")}
        title={t("settingsPluginsInstalled")}
      >
        {plugins.length === 0 ? (
          <div className="flex min-h-20 flex-col items-center justify-center gap-2 text-center text-[12px] text-muted-foreground">
            <PackageOpen className="h-5 w-5 opacity-60" />
            {t("settingsPluginsEmpty")}
          </div>
        ) : (
          plugins.map((plugin) => {
            const title = getLocalizedText(plugin.manifest.name, i18n.language);
            const description = getLocalizedText(
              plugin.manifest.description,
              i18n.language
            );
            const canToggle =
              plugin.status !== "incompatible" && plugin.status !== "invalid";
            let statusLabel = "";
            if (plugin.status === "failed") {
              statusLabel = t("settingsPluginsFailed");
            } else if (plugin.status === "incompatible") {
              statusLabel = t("settingsPluginsIncompatible");
            } else if (plugin.status === "invalid") {
              statusLabel = t("settingsPluginsInvalid");
            }
            const sourceLabel =
              plugin.source === "builtin"
                ? t("settingsPluginsBuiltin")
                : t("settingsPluginsLocal");
            return (
              <SettingRow
                action={
                  <div className="flex max-w-full items-center gap-2">
                    <Switch
                      ariaLabel={`${t("settingsPluginsEnable")} ${title}`}
                      checked={plugin.enabled}
                      disabled={!canToggle}
                      onCheckedChange={(checked) => {
                        (checked
                          ? enable(plugin.manifest.id)
                          : disable(plugin.manifest.id)
                        ).catch(() => undefined);
                      }}
                    />
                    {plugin.source === "local" && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            aria-label={t("settingsPluginsUninstall")}
                            onClick={() => {
                              uninstall(plugin.manifest.id).catch(
                                () => undefined
                              );
                            }}
                            size="icon-xs"
                            variant="ghost"
                          >
                            <Trash2 />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {t("settingsPluginsUninstall")}
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                }
                description={`${description} · ${sourceLabel} · v${plugin.manifest.version}${statusLabel ? ` · ${statusLabel}` : ""}`}
                key={plugin.manifest.id}
                title={title}
              />
            );
          })
        )}
      </SettingsSection>
      {activePlugin ? (
        <SettingsSection
          description={t("settingsPluginsConfigurationHint")}
          title={`${activePluginName} · ${t("settingsPluginsConfiguration")}`}
        >
          <PluginSettingsSlot slot="plugin.settings" />
        </SettingsSection>
      ) : null}
    </SettingsPageShell>
  );
}

export const Route = createFileRoute("/settings/plugins")({
  component: PluginsSettingsPage,
});
