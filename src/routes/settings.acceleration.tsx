import { createFileRoute } from "@tanstack/react-router";
import { useRef } from "react";
import { GpuSettingsCard } from "@/components/gpu-settings-card";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";

function AccelerationSettingsPage() {
  const scrollRef = useRef<HTMLDivElement>(null);
  useRouteScrollRestoration(scrollRef);

  return (
    <div className="h-full overflow-y-auto p-6" ref={scrollRef}>
      <GpuSettingsCard />
    </div>
  );
}

export const Route = createFileRoute("/settings/acceleration")({
  component: AccelerationSettingsPage,
});
