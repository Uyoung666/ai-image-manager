import { LOCAL_STORAGE_KEYS } from "@/constants";
import { ipc } from "@/ipc/manager";
import type { ThemeMode } from "@/types/theme-mode";

export type { ThemeMode };

interface TemporaryThemeOverride {
  mode: "dark";
  token: symbol;
}

let temporaryThemeOverride: TemporaryThemeOverride | null = null;
let latestSystemResolvedTheme: "dark" | "light" | null = null;

export async function getCurrentTheme(): Promise<ThemeMode> {
  const local = localStorage.getItem(
    LOCAL_STORAGE_KEYS.THEME
  ) as ThemeMode | null;
  return local || "system";
}

export async function getResolvedTheme(): Promise<"dark" | "light"> {
  const mode = await getCurrentTheme();
  if (mode === "system") {
    return getSystemResolvedTheme();
  }
  return mode;
}

export async function setTheme(newTheme: ThemeMode) {
  await ipc.client.theme.setThemeMode(newTheme);
  localStorage.setItem(LOCAL_STORAGE_KEYS.THEME, newTheme);
  if (newTheme === "system") {
    latestSystemResolvedTheme = null;
  }
  applyResolvedTheme();
}

/**
 * Temporarily force the document into dark mode without changing the user's
 * persisted theme preference or Electron's native theme source.
 *
 * The returned cleanup function restores the current persisted theme. A
 * token prevents an older cleanup from clearing a newer override.
 */
export function enterTemporaryDarkTheme(): () => void {
  const token = Symbol("temporary-dark-theme");
  latestSystemResolvedTheme = null;
  temporaryThemeOverride = { mode: "dark", token };
  updateDocumentTheme(true);

  let active = true;
  return () => {
    if (!active) {
      return;
    }
    active = false;

    if (temporaryThemeOverride?.token !== token) {
      return;
    }

    temporaryThemeOverride = null;
    applyResolvedTheme();
  };
}

export async function toggleTheme() {
  const current = await getCurrentTheme();
  // Cycle: dark → light → system → dark
  const order: ThemeMode[] = ["dark", "light", "system"];
  const idx = order.indexOf(current);
  const next = order[(idx + 1) % order.length];
  await setTheme(next);
}

export async function syncWithLocalTheme() {
  const local = localStorage.getItem(
    LOCAL_STORAGE_KEYS.THEME
  ) as ThemeMode | null;
  await setTheme(local || "system");
}

async function applyResolvedTheme() {
  if (temporaryThemeOverride?.mode === "dark") {
    updateDocumentTheme(true);
    return;
  }

  const mode = await getCurrentTheme();
  if (temporaryThemeOverride?.mode === "dark") {
    updateDocumentTheme(true);
    return;
  }

  let isDark: boolean;
  if (mode === "system") {
    isDark = getSystemResolvedTheme() === "dark";
  } else {
    isDark = mode === "dark";
  }
  updateDocumentTheme(isDark);
}

export function listenSystemThemeChanges() {
  function handler(event: MessageEvent) {
    if (event.data?.channel === "theme:system-changed") {
      latestSystemResolvedTheme =
        event.data.resolved === "dark" ? "dark" : "light";
      getCurrentTheme().then((mode) => {
        if (mode === "system" && !temporaryThemeOverride) {
          updateDocumentTheme(latestSystemResolvedTheme === "dark");
        }
      });
    }
  }
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}

function getSystemResolvedTheme(): "dark" | "light" {
  if (latestSystemResolvedTheme) {
    return latestSystemResolvedTheme;
  }

  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  return "light";
}

function updateDocumentTheme(isDark: boolean) {
  const html = document.documentElement;
  // Enable transition class for smooth color shift
  html.classList.add("transitioning");
  html.classList.toggle("dark", isDark);
  html.classList.toggle("light", !isDark);
  // Remove transition class after animation completes
  setTimeout(() => html.classList.remove("transitioning"), 300);
}
