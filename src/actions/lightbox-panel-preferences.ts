export const LIGHTBOX_PANEL_MODE_STORAGE_KEY = "lightbox.panel-mode";

export const LIGHTBOX_PANEL_MODES = ["off", "info", "thumbnails"] as const;

export type LightboxPanelMode = (typeof LIGHTBOX_PANEL_MODES)[number];

export const DEFAULT_LIGHTBOX_PANEL_MODE: LightboxPanelMode = "off";

function isPanelMode(value: unknown): value is LightboxPanelMode {
  return (
    typeof value === "string" &&
    LIGHTBOX_PANEL_MODES.includes(value as LightboxPanelMode)
  );
}

function getStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readLightboxPanelMode(): LightboxPanelMode {
  const storage = getStorage();
  if (!storage) {
    return DEFAULT_LIGHTBOX_PANEL_MODE;
  }

  try {
    const stored = storage.getItem(LIGHTBOX_PANEL_MODE_STORAGE_KEY);
    return isPanelMode(stored) ? stored : DEFAULT_LIGHTBOX_PANEL_MODE;
  } catch {
    return DEFAULT_LIGHTBOX_PANEL_MODE;
  }
}

export function saveLightboxPanelMode(value: unknown): boolean {
  const storage = getStorage();
  if (!(storage && isPanelMode(value))) {
    return false;
  }

  try {
    storage.setItem(LIGHTBOX_PANEL_MODE_STORAGE_KEY, value);
    return true;
  } catch {
    return false;
  }
}
