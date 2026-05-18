import { LOCAL_STORAGE_KEYS } from "@/constants";
import { ipc } from "@/ipc/manager";
import type { ThemeMode } from "@/types/theme-mode";

export type { ThemeMode };

export async function getCurrentTheme(): Promise<ThemeMode> {
  const local = localStorage.getItem(
    LOCAL_STORAGE_KEYS.THEME
  ) as ThemeMode | null;
  return local || "system";
}

export async function getResolvedTheme(): Promise<"dark" | "light"> {
  const mode = await getCurrentTheme();
  if (mode === "system") {
    const sys = await ipc.client.theme.getCurrentThemeMode();
    return sys === "dark" ? "dark" : "light";
  }
  return mode;
}

export async function setTheme(newTheme: ThemeMode) {
  await ipc.client.theme.setThemeMode(newTheme);
  localStorage.setItem(LOCAL_STORAGE_KEYS.THEME, newTheme);
  applyResolvedTheme();
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
  const mode = await getCurrentTheme();
  let isDark: boolean;
  if (mode === "system") {
    const sys = await ipc.client.theme.getCurrentThemeMode();
    isDark = sys === "dark";
  } else {
    isDark = mode === "dark";
  }
  updateDocumentTheme(isDark);
}

export function listenSystemThemeChanges() {
  function handler(event: MessageEvent) {
    if (event.data?.channel === "theme:system-changed") {
      getCurrentTheme().then((mode) => {
        if (mode === "system") {
          updateDocumentTheme(event.data.resolved === "dark");
        }
      });
    }
  }
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
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
