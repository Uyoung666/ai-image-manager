import { getSetting } from "@/services/settings-manager";

export type SearchSensitivity = "relaxed" | "standard" | "precise";

export const SEARCH_SENSITIVITY_OPTIONS: SearchSensitivity[] = [
  "relaxed",
  "standard",
  "precise",
];

// 阈值乘数：relaxed < 1 → 更宽松（召回更多结果）；precise > 1 → 更严格
// （只保留高匹配）。standard = 1 等价于现状。
export const SEARCH_SENSITIVITY_MULTIPLIERS: Record<SearchSensitivity, number> =
  {
    relaxed: 0.6,
    standard: 1,
    precise: 1.4,
  };

const SEARCH_SENSITIVITY_KEY = "search.sensitivity";

/** 从 app_settings 读取当前灵敏度预设，非法/缺省回退 "standard"。 */
export function getActiveSearchSensitivity(): SearchSensitivity {
  try {
    const raw = getSetting(SEARCH_SENSITIVITY_KEY);
    if (raw === "relaxed" || raw === "standard" || raw === "precise") {
      return raw;
    }
  } catch {
    // Settings DB not ready during early startup — fall through to default.
  }
  return "standard";
}

/** 预设 → 阈值乘数，带 clamp 防御越界。 */
export function getSensitivityMultiplier(preset: SearchSensitivity): number {
  const raw = SEARCH_SENSITIVITY_MULTIPLIERS[preset] ?? 1;
  return Math.min(2, Math.max(0.5, raw));
}
