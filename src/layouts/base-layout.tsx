import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import DragWindowRegion from "@/components/drag-window-region";
import { KeyboardShortcuts } from "@/components/KeyboardShortcuts";
import { PerfOverlay, usePerfMonitor } from "@/components/PerfMonitor";
import { SpotlightSearch } from "@/components/SpotlightSearch";

function isPerfMonitorEnabled() {
  try {
    return localStorage.getItem("DEV_PERF_MONITOR") === "true";
  } catch {
    return false;
  }
}

export default function BaseLayout({ children }: { children: ReactNode }) {
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [perfOn] = useState(isPerfMonitorEnabled);
  const { metrics, memory } = usePerfMonitor(perfOn);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // ? key (with or without shift)
      if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const target = e.target as HTMLElement;
        // Don't trigger when typing in input/textarea/search
        if (
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable
        ) {
          return;
        }
        e.preventDefault();
        setShortcutsOpen((prev) => !prev);
      }
      if (e.key === "Escape" && shortcutsOpen) {
        setShortcutsOpen(false);
      }
    },
    [shortcutsOpen]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <DragWindowRegion title="AI Image Manager" />
      <main className="flex-1 overflow-hidden">{children}</main>
      <SpotlightSearch />
      <KeyboardShortcuts
        onClose={() => setShortcutsOpen(false)}
        open={shortcutsOpen}
      />
      {perfOn && <PerfOverlay memory={memory} metrics={metrics} />}
    </div>
  );
}
