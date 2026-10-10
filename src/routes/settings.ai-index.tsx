import { createFileRoute } from "@tanstack/react-router";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { AiProgressBar } from "@/components/AiProgressBar";
import { SettingsPageShell } from "@/components/settings/settings-page-shell";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";

function AiIndexSettingsPage() {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  useRouteScrollRestoration(scrollRef);

  return (
    <SettingsPageShell
      description={t("settingsAiIndexDescription")}
      scrollRef={scrollRef}
      title={t("settingsAiIndex")}
    >
      <AiProgressBar />
    </SettingsPageShell>
  );
}

export const Route = createFileRoute("/settings/ai-index")({
  component: AiIndexSettingsPage,
});
