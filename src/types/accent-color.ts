export const ACCENT_COLOR_OPTIONS = [
  {
    color: "#8952EE",
    labelKey: "accentColorDefault",
    value: "default",
  },
  {
    color: "#3A83F7",
    labelKey: "accentColorBlue",
    value: "blue",
  },
  {
    color: "#53B559",
    labelKey: "accentColorGreen",
    value: "green",
  },
  {
    color: "#F6C543",
    labelKey: "accentColorYellow",
    value: "yellow",
  },
  {
    color: "#F077AF",
    labelKey: "accentColorPink",
    value: "pink",
  },
  {
    color: "#EE7C37",
    labelKey: "accentColorOrange",
    value: "orange",
  },
  {
    color: "#B4B4B4",
    labelKey: "accentColorGray",
    value: "gray",
  },
  {
    color: "#000000",
    labelKey: "accentColorBlack",
    value: "black",
  },
] as const;

export type AccentColor = (typeof ACCENT_COLOR_OPTIONS)[number]["value"];
export type AccentTheme = "dark" | "light";

export const ACCENT_COLOR_KEY = "ui.accentColor";
export const DEFAULT_ACCENT_COLOR: AccentColor = "default";

const ACCENT_COLOR_VALUES = new Set<string>(
  ACCENT_COLOR_OPTIONS.map((option) => option.value)
);

export function isAccentColorAvailable(
  value: AccentColor,
  theme: AccentTheme
): boolean {
  if (value === "gray") {
    return theme === "dark";
  }
  if (value === "black") {
    return theme === "light";
  }
  return true;
}

export function getAccentColorOptions(theme: AccentTheme) {
  return ACCENT_COLOR_OPTIONS.filter((option) =>
    isAccentColorAvailable(option.value, theme)
  );
}

export function parseAccentColor(
  value: string | null | undefined,
  theme?: AccentTheme
): AccentColor {
  const parsed =
    value && ACCENT_COLOR_VALUES.has(value)
      ? (value as AccentColor)
      : DEFAULT_ACCENT_COLOR;

  return theme && !isAccentColorAvailable(parsed, theme)
    ? DEFAULT_ACCENT_COLOR
    : parsed;
}
