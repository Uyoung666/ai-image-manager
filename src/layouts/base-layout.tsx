import type React from "react";
import DragWindowRegion from "@/components/drag-window-region";

export default function BaseLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <DragWindowRegion title="AI Image Manager" />
      <main className="flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
