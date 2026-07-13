import { createFileRoute } from "@tanstack/react-router";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { CloudConfigPanel } from "@/components/CloudConfigPanel";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";

function CloudSyncSettingsPage() {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  useRouteScrollRestoration(scrollRef);

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6" ref={scrollRef}>
      <section className="mx-auto w-full max-w-[820px] space-y-3">
        <h2 className="font-semibold text-[14px] text-foreground">
          {t("cloudSync")}
        </h2>
        <CloudConfigPanel />
      </section>
    </div>
  );
}

export const Route = createFileRoute("/settings/cloud-sync")({
  component: CloudSyncSettingsPage,
});
