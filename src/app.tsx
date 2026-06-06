import { RouterProvider } from "@tanstack/react-router";
import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import { Toaster, toast } from "sonner";
import { updateAppLanguage } from "./actions/language";
import { listenSystemThemeChanges, syncWithLocalTheme } from "./actions/theme";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { GpuDetectionDialog } from "./components/gpu-detection-dialog";
import { ipc } from "./ipc/manager";
import { QueryProvider } from "./providers/QueryProvider";
import { router } from "./utils/routes";
import "./localization/i18n";

export default function App() {
  const { t, i18n } = useTranslation();

  // ── GPU detection dialog state ────────────────────────────────────
  const [gpuDialogOpen, setGpuDialogOpen] = useState(false);
  const [gpuDialogName, setGpuDialogName] = useState<string | undefined>();

  useEffect(() => {
    syncWithLocalTheme();
    updateAppLanguage(i18n);
  }, [i18n]);

  // Listen for OS-level theme changes when using "system" mode
  useEffect(() => {
    return listenSystemThemeChanges();
  }, []);

  // Listen for update availability
  const handleUpdate = useCallback(
    (event: MessageEvent) => {
      if (event.data?.channel === "update:available") {
        toast(t("updateDownloaded", { version: event.data.version }), {
          duration: 30_000,
          action: {
            label: t("updateRestart"),
            onClick: () => {
              window.electronAPI?.restartApp?.();
            },
          },
        });
      }
    },
    [t]
  );

  useEffect(() => {
    window.addEventListener("message", handleUpdate);
    return () => window.removeEventListener("message", handleUpdate);
  }, [handleUpdate]);

  // Listen for GPU detection prompt from main process (push)
  const handleGpuPrompt = useCallback((event: MessageEvent) => {
    if (event.data?.channel === "gpu:prompt-user") {
      setGpuDialogName(event.data?.gpuName);
      setGpuDialogOpen(true);
    }
  }, []);

  useEffect(() => {
    window.addEventListener("message", handleGpuPrompt);
    return () => window.removeEventListener("message", handleGpuPrompt);
  }, [handleGpuPrompt]);

  // Pull GPU prompt status on mount — safety net if the push message
  // arrived before the React listener was registered.
  useEffect(() => {
    ipc.client.settings
      .getGpuSettings({})
      .then(
        (r: {
          detected?: { dmlAvailable?: boolean; gpuName?: string } | null;
          enabled?: boolean;
          promptShown?: boolean;
        }) => {
          if (r.detected?.dmlAvailable && !r.enabled && !r.promptShown) {
            setGpuDialogName(r.detected.gpuName);
            setGpuDialogOpen(true);
          }
        }
      );
  }, []);

  const handleGpuDialogClose = useCallback(() => {
    setGpuDialogOpen(false);
  }, []);

  return (
    <ErrorBoundary>
      <QueryProvider>
        <RouterProvider router={router} />
        <GpuDetectionDialog
          gpuName={gpuDialogName}
          onClose={handleGpuDialogClose}
          open={gpuDialogOpen}
        />
        <Toaster
          position="bottom-right"
          toastOptions={{
            style: {
              background: "var(--popover)",
              color: "var(--foreground)",
              border: "1px solid var(--border)",
            },
          }}
        />
      </QueryProvider>
    </ErrorBoundary>
  );
}

const container = document.getElementById("app");
if (!container) {
  throw new Error('Root element with id "app" not found');
}
const root = createRoot(container);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
