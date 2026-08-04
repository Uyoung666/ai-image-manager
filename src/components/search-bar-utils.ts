import type { ExifFilters } from "@/types/search";

const HISTORY_KEY = "search_history";
export const MAX_HISTORY = 20;

export interface TagInfo {
  color: string | null;
  id: number;
  name: string;
}

export interface TimePreset {
  getRange: () => { dateFrom: string; dateTo: string };
  label: string;
}

export interface SearchSuggestion {
  category?: string;
  color?: string;
  tagId?: number;
  text: string;
  type: "example" | "person" | "dictionary" | "tag" | "history";
  /** 人物身份元数据（仅 type === "person" 时携带，用于头像渲染与精准导航） */
  id?: number;
  coverThumbnailPath?: string | null;
  coverPhotoPath?: string | null;
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function getTimePresets(t: (key: string) => string): TimePreset[] {
  return [
    {
      label: t("today"),
      getRange: () => {
        const d = formatDate(new Date());
        return { dateFrom: d, dateTo: d };
      },
    },
    {
      label: t("thisWeek"),
      getRange: () => {
        const now = new Date();
        const dayOfWeek = now.getDay();
        const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        const monday = new Date(now);
        monday.setDate(now.getDate() - diff);
        return { dateFrom: formatDate(monday), dateTo: formatDate(now) };
      },
    },
    {
      label: t("thisMonth"),
      getRange: () => {
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth(), 1);
        return { dateFrom: formatDate(start), dateTo: formatDate(now) };
      },
    },
    {
      label: t("thisYear"),
      getRange: () => {
        const now = new Date();
        const start = new Date(now.getFullYear(), 0, 1);
        return { dateFrom: formatDate(start), dateTo: formatDate(now) };
      },
    },
    {
      label: t("lastYear"),
      getRange: () => {
        const y = new Date().getFullYear() - 1;
        return {
          dateFrom: formatDate(new Date(y, 0, 1)),
          dateTo: formatDate(new Date(y, 11, 31)),
        };
      },
    },
  ];
}

export function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveHistory(items: string[]) {
  try {
    localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify(items.slice(0, MAX_HISTORY))
    );
  } catch {
    /* ignore */
  }
}

export function clearSavedHistory() {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    /* ignore */
  }
}

export function getFilterLabel(
  key: keyof ExifFilters,
  value: string | undefined
): string {
  if (!value) {
    return "";
  }
  switch (key) {
    case "advancedField":
      return value;
    case "advancedValue":
      return value;
    case "cameraModel":
      return value;
    case "creator":
      return value;
    case "lensModel":
      return value;
    case "isoMin":
      return `ISO ≥ ${value}`;
    case "isoMax":
      return `ISO ≤ ${value}`;
    case "apertureMin":
      return `光圈 ≥ f/${value}`;
    case "apertureMax":
      return `光圈 ≤ f/${value}`;
    case "focalMin":
      return `焦段 ≥ ${value}mm`;
    case "focalMax":
      return `焦段 ≤ ${value}mm`;
    case "shutterMin":
      return `快门 ≥ ${value}s`;
    case "shutterMax":
      return `快门 ≤ ${value}s`;
    case "dateFrom":
      return `从 ${value}`;
    case "dateMonth":
      return `月份 ${value}`;
    case "dateHour":
      return `${value.padStart(2, "0")}:00–${String((Number(value) + 1) % 24).padStart(2, "0")}:00`;
    case "dateTo":
      return `至 ${value}`;
    default:
      return value;
  }
}
