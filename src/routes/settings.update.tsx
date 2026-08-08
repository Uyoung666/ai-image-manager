import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { UpdateSection } from "@/components/settings/UpdateSection";
import { UpdateChangelogHistory } from "@/components/settings/update-changelog-history";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
import { ipc } from "@/ipc/manager";

function UpdateSettingsPage() {
  const [appVersion, setAppVersion] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  useRouteScrollRestoration(scrollRef);

  useEffect(() => {
    ipc.client.app.appVersion({}).then((v) => setAppVersion(v as string));
  }, []);

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6" ref={scrollRef}>
      <div className="mx-auto w-full max-w-[820px]">
        <UpdateSection appVersion={appVersion} />
        <UpdateChangelogHistory />
      </div>
    </div>
  );
}

export const Route = createFileRoute("/settings/update")({
  component: UpdateSettingsPage,
});
