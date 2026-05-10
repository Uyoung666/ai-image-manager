import { type ReactNode, useCallback, useEffect, useState } from "react";
import DragWindowRegion from "@/components/drag-window-region";
import { KeyboardShortcuts } from "@/components/KeyboardShortcuts";

export default function BaseLayout({ children }: { children: ReactNode }) {
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

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
      <KeyboardShortcuts
        onClose={() => setShortcutsOpen(false)}
        open={shortcutsOpen}
      />
    </div>
  );
}
