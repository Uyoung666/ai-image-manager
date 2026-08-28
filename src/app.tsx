import { RouterProvider } from "@tanstack/react-router";
import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import { Toaster, toast } from "sonner";
import {
  applyAccentColor,
  cacheAccentColor,
  setAccentColorPreference,
} from "./actions/accent-color";
import { initializeAppLanguage } from "./actions/language";
import { listenSystemThemeChanges, syncWithLocalTheme } from "./actions/theme";
import { installDownloadedUpdate } from "./actions/update";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { UiPreferencesProvider } from "./contexts/ui-preferences-context";
import { ipc } from "./ipc/manager";
import i18n from "./localization/i18n";
import { PluginBackdropHost, PluginHostProvider } from "./plugins/runtime";
import { QueryProvider } from "./providers/QueryProvider";
import { router } from "./utils/routes";

export default function App() {
  const { t } = useTranslation();
  const [updateReminder, setUpdateReminder] = useState(true);

  useEffect(() => {
    syncWithLocalTheme();
  }, []);

  useEffect(() => {
    ipc.client.settings
      .getAppPreferences({})
      .then((preferences) => {
        const accentColor = applyAccentColor(preferences.accentColor);
        cacheAccentColor(accentColor);
        if (accentColor !== preferences.accentColor) {
          setAccentColorPreference(accentColor).catch(() => undefined);
        }
        setUpdateReminder(preferences.updateReminder);
      })
      .catch(() => undefined);
    function handleReminder(event: Event) {
      setUpdateReminder((event as CustomEvent<boolean>).detail === true);
    }
    window.addEventListener("update-reminder-changed", handleReminder);
    return () =>
      window.removeEventListener("update-reminder-changed", handleReminder);
  }, []);

  // Listen for OS-level theme changes when using "system" mode
  useEffect(() => {
    return listenSystemThemeChanges();
  }, []);

  // Listen for update availability
  const handleUpdate = useCallback(
    (event: MessageEvent) => {
      if (updateReminder && event.data?.channel === "update:available") {
        toast(t("updateDownloaded", { version: event.data.version }), {
          duration: 30_000,
          action: {
            label: t("updateRestart"),
            onClick: async () => {
              await installDownloadedUpdate();
            },
          },
        });
      }
    },
    [t, updateReminder]
  );

  useEffect(() => {
    window.addEventListener("message", handleUpdate);
    return () => window.removeEventListener("message", handleUpdate);
  }, [handleUpdate]);

  return (
    <ErrorBoundary>
      <UiPreferencesProvider>
        <PluginHostProvider>
          <PluginBackdropHost />
          <QueryProvider>
            <RouterProvider router={router} />
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
        </PluginHostProvider>
      </UiPreferencesProvider>
    </ErrorBoundary>
  );
}

const container = document.getElementById("app");
if (!container) {
  throw new Error('Root element with id "app" not found');
}

// 封印浏览器原生 scrollRestoration，防止 SPA 路由切换时与 React
// 虚拟化状态机争抢 DOM 控制权导致 Scroll Clamping。
if ("scrollRestoration" in window.history) {
  window.history.scrollRestoration = "manual";
}

const root = createRoot(container);

// Load the selected signed locale before mounting React. This prevents the
// first frame from rendering built-in Chinese/English and then visibly
// switching to a plugin catalog after the IPC handshake completes.
async function bootstrapRenderer() {
  try {
    await initializeAppLanguage(i18n);
  } catch {
    // The action already has a built-in fallback, but a renderer must still
    // mount if an unexpected adapter/document error escapes that boundary.
  } finally {
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
  }
}

bootstrapRenderer().catch(() => undefined);
