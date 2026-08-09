import { createFileRoute } from "@tanstack/react-router";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { DiagnosticsReportForm } from "@/components/diagnostics-report-form";
import {
  SettingsPageShell,
  SettingsSection,
} from "@/components/settings/settings-page-shell";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";

function DiagnosticsSettingsPage() {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  useRouteScrollRestoration(scrollRef);

  return (
    <SettingsPageShell
      description={t("diagnosticsDescription")}
      scrollRef={scrollRef}
      title={t("settingsDiagnostics")}
    >
      <SettingsSection
        description={t("diagnosticsSectionDescription")}
        title={t("diagnosticsReportProblem")}
      >
        <DiagnosticsReportForm />
      </SettingsSection>
    </SettingsPageShell>
  );
}

export const Route = createFileRoute("/settings/diagnostics")({
  component: DiagnosticsSettingsPage,
});
