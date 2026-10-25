export interface ExportPreferences {
  format: "original" | "compressed";
  maxWidth: number;
  openAfterExport: boolean;
  quality: number;
}
const KEY = "photo-export.preferences";
const DEFAULTS: ExportPreferences = {
  format: "original",
  quality: 85,
  maxWidth: 1920,
  openAfterExport: false,
};
export function readExportPreferences(): ExportPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!value || typeof value !== "object") {
      return { ...DEFAULTS };
    }
    return {
      format: value.format === "compressed" ? "compressed" : "original",
      quality:
        Number.isInteger(value.quality) &&
        value.quality >= 10 &&
        value.quality <= 100
          ? value.quality
          : DEFAULTS.quality,
      maxWidth:
        Number.isInteger(value.maxWidth) &&
        value.maxWidth >= 640 &&
        value.maxWidth <= 3840
          ? value.maxWidth
          : DEFAULTS.maxWidth,
      openAfterExport: value.openAfterExport === true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}
export function saveExportPreferences(value: ExportPreferences) {
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    /* Storage can be unavailable. */
  }
}
