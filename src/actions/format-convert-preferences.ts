export const FORMAT_CONVERT_PREFERENCES_STORAGE_KEY =
  "format-convert.preferences";

export const FORMAT_CONVERT_FORMATS = ["jpg", "png", "webp", "avif"] as const;

export type FormatConvertFormat = (typeof FORMAT_CONVERT_FORMATS)[number];

export interface FormatConvertPreferences {
  format: FormatConvertFormat;
  maxWidth: string;
  outputDir: string;
  quality: number;
}

export const DEFAULT_FORMAT_CONVERT_PREFERENCES: FormatConvertPreferences = {
  format: "webp",
  quality: 85,
  maxWidth: "",
  outputDir: "",
};

const MAX_WIDTH_PATTERN = /^\d+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFormat(value: unknown): value is FormatConvertFormat {
  return (
    typeof value === "string" &&
    FORMAT_CONVERT_FORMATS.includes(value as FormatConvertFormat)
  );
}

function parseQuality(value: unknown) {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 10 &&
    value <= 100
    ? value
    : DEFAULT_FORMAT_CONVERT_PREFERENCES.quality;
}

function parseMaxWidth(value: unknown) {
  if (value === "") {
    return "";
  }
  if (typeof value !== "string" || !MAX_WIDTH_PATTERN.test(value)) {
    return DEFAULT_FORMAT_CONVERT_PREFERENCES.maxWidth;
  }

  const numericValue = Number(value);
  return Number.isSafeInteger(numericValue) && numericValue >= 0
    ? value
    : DEFAULT_FORMAT_CONVERT_PREFERENCES.maxWidth;
}

function normalizePreferences(value: unknown): FormatConvertPreferences {
  const stored = isRecord(value) ? value : {};
  return {
    format: isFormat(stored.format)
      ? stored.format
      : DEFAULT_FORMAT_CONVERT_PREFERENCES.format,
    quality: parseQuality(stored.quality),
    maxWidth: parseMaxWidth(stored.maxWidth),
    outputDir:
      typeof stored.outputDir === "string"
        ? stored.outputDir
        : DEFAULT_FORMAT_CONVERT_PREFERENCES.outputDir,
  };
}

function getStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readFormatConvertPreferences(): FormatConvertPreferences {
  const storage = getStorage();
  if (!storage) {
    return { ...DEFAULT_FORMAT_CONVERT_PREFERENCES };
  }

  try {
    const raw = storage.getItem(FORMAT_CONVERT_PREFERENCES_STORAGE_KEY);
    return raw
      ? normalizePreferences(JSON.parse(raw))
      : { ...DEFAULT_FORMAT_CONVERT_PREFERENCES };
  } catch {
    return { ...DEFAULT_FORMAT_CONVERT_PREFERENCES };
  }
}

export function saveFormatConvertPreferences(value: unknown): boolean {
  const storage = getStorage();
  if (!storage) {
    return false;
  }

  try {
    storage.setItem(
      FORMAT_CONVERT_PREFERENCES_STORAGE_KEY,
      JSON.stringify(normalizePreferences(value))
    );
    return true;
  } catch {
    return false;
  }
}
