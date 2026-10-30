import { RouterProvider } from "@tanstack/react-router";
import { useEffect } from "react";
import { Toaster } from "sonner";
import {
  applyAccentColor,
  cacheAccentColor,
  setAccentColorPreference,
} from "./actions/accent-color";
import { listenSystemThemeChanges, syncWithLocalTheme } from "./actions/theme";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { IconMotionProvider } from "./components/icons/icon-motion";
import { UpdateNotification } from "./components/update-notification";
import { UiPreferencesProvider } from "./contexts/ui-preferences-context";
import { UpdateUiProvider } from "./hooks/use-update-ui";
import { ipc } from "./ipc/manager";
import { PluginBackdropHost, PluginHostProvider } from "./plugins/runtime";
import { QueryProvider } from "./providers/QueryProvider";
import { scheduleDevRendererFirstFrame } from "./utils/dev-startup-readiness";
import { router } from "./utils/routes";

export default function App() {
  useEffect(() => {
    if (import.meta.env.DEV) {
      return scheduleDevRendererFirstFrame();
    }
  }, []);

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
      })
      .catch(() => undefined);
  }, []);

  // Listen for OS-level theme changes when using "system" mode
  useEffect(() => {
    return listenSystemThemeChanges();
  }, []);

  return (
    <ErrorBoundary>
      <UiPreferencesProvider>
        <IconMotionProvider>
          <PluginHostProvider>
            <PluginBackdropHost />
            <QueryProvider>
              <UpdateUiProvider>
                <RouterProvider router={router} />
                <UpdateNotification />
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
              </UpdateUiProvider>
            </QueryProvider>
          </PluginHostProvider>
        </IconMotionProvider>
      </UiPreferencesProvider>
    </ErrorBoundary>
  );
}
