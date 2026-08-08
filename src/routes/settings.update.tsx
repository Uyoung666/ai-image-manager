import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsPageShell } from "@/components/settings/settings-page-shell";
import { UpdateSection } from "@/components/settings/UpdateSection";
import { UpdateChangelogHistory } from "@/components/settings/update-changelog-history";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
import { ipc } from "@/ipc/manager";

function UpdateSettingsPage() {
  const { t } = useTranslation();
  const [appVersion, setAppVersion] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  useRouteScrollRestoration(scrollRef);

  useEffect(() => {
    ipc.client.app.appVersion({}).then((v) => setAppVersion(v as string));
  }, []);

  return (
    <SettingsPageShell scrollRef={scrollRef} title={t("settingsGroupUpdates")}>
      <div className="space-y-6">
        <UpdateSection appVersion={appVersion} />
        <UpdateChangelogHistory />
      </div>
    </SettingsPageShell>
  );
}

export const Route = createFileRoute("/settings/update")({
  component: UpdateSettingsPage,
});
