import { createFileRoute } from "@tanstack/react-router";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { CloudConfigPanel } from "@/components/CloudConfigPanel";
import { SettingsPageShell } from "@/components/settings/settings-page-shell";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";

function CloudSyncSettingsPage() {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  useRouteScrollRestoration(scrollRef);

  return (
    <SettingsPageShell scrollRef={scrollRef} title={t("cloudSync")}>
      <CloudConfigPanel />
    </SettingsPageShell>
  );
}

export const Route = createFileRoute("/settings/cloud-sync")({
  component: CloudSyncSettingsPage,
});
