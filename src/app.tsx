import { RouterProvider } from "@tanstack/react-router";
import React, { useCallback, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import { Toaster, toast } from "sonner";
import { updateAppLanguage } from "./actions/language";
import { listenSystemThemeChanges, syncWithLocalTheme } from "./actions/theme";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { QueryProvider } from "./providers/QueryProvider";
import { router } from "./utils/routes";
import "./localization/i18n";

export default function App() {
  const { t, i18n } = useTranslation();

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

  return (
    <ErrorBoundary>
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
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
