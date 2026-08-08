import { createFileRoute } from "@tanstack/react-router";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { GpuSettingsCard } from "@/components/gpu-settings-card";
import { SettingsPageShell } from "@/components/settings/settings-page-shell";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";

function AccelerationSettingsPage() {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  useRouteScrollRestoration(scrollRef);

  return (
    <SettingsPageShell scrollRef={scrollRef} title={t("gpuAcceleration")}>
      <GpuSettingsCard />
    </SettingsPageShell>
  );
}

export const Route = createFileRoute("/settings/acceleration")({
  component: AccelerationSettingsPage,
});
