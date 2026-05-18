import { RouterProvider } from "@tanstack/react-router";
import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import { Toaster } from "sonner";
import { updateAppLanguage } from "./actions/language";
import { listenSystemThemeChanges, syncWithLocalTheme } from "./actions/theme";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { QueryProvider } from "./providers/QueryProvider";
import { router } from "./utils/routes";
import "./localization/i18n";

export default function App() {
  const { i18n } = useTranslation();

  useEffect(() => {
    syncWithLocalTheme();
    updateAppLanguage(i18n);
  }, [i18n]);

  // Listen for OS-level theme changes when using "system" mode
  useEffect(() => {
    return listenSystemThemeChanges();
  }, []);

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
const root = createRoot(container);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
