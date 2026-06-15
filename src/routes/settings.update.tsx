import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { UpdateSection } from "@/components/settings/UpdateSection";
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
    <div className="h-full overflow-y-auto p-6" ref={scrollRef}>
      <UpdateSection appVersion={appVersion} />
    </div>
  );
}

export const Route = createFileRoute("/settings/update")({
  component: UpdateSettingsPage,
});
