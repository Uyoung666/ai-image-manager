import { RouterProvider } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Toaster } from "sonner";
import {
  applyAccentColor,
  cacheAccentColor,
  setAccentColorPreference,
} from "./actions/accent-color";
import { listenSystemThemeChanges, syncWithLocalTheme } from "./actions/theme";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { UpdateNotification } from "./components/update-notification";
import { UiPreferencesProvider } from "./contexts/ui-preferences-context";
import { ipc } from "./ipc/manager";
import { PluginBackdropHost, PluginHostProvider } from "./plugins/runtime";
import { QueryProvider } from "./providers/QueryProvider";
import { router } from "./utils/routes";

export default function App() {
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

  return (
    <ErrorBoundary>
      <UiPreferencesProvider>
        <PluginHostProvider>
          <PluginBackdropHost />
          <QueryProvider>
            <RouterProvider router={router} />
            <UpdateNotification reminder={updateReminder} />
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
