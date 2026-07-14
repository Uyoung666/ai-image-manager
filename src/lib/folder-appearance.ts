export const FOLDER_APPEARANCE_ICONS = [
  "folder",
  "image",
  "camera",
  "plane",
  "map-pin",
  "users",
  "user",
  "heart",
  "briefcase",
  "file-text",
  "download",
  "cloud",
  "star",
  "archive",
  "palette",
  "music",
  "video",
  "home",
  "mountain",
  "paw-print",
] as const;

export type FolderAppearanceIcon = (typeof FOLDER_APPEARANCE_ICONS)[number];

export const FOLDER_APPEARANCE_COLORS = [
  "#5E6AD2",
  "#2563EB",
  "#0891B2",
  "#059669",
  "#65A30D",
  "#CA8A04",
  "#EA580C",
  "#DC2626",
  "#DB2777",
  "#9333EA",
] as const;

export const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export function getFolderInitial(displayName: string): string {
  const trimmed = displayName.trim();
  if (!trimmed) {
    return "?";
  }
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const first = segmenter.segment(trimmed)[Symbol.iterator]().next()
    .value?.segment;
  return first?.toLocaleUpperCase() || "?";
}

export function getAutomaticFolderColor(path: string): string {
  let hash = 0;
  for (const character of path) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 2_147_483_647;
  }
  return FOLDER_APPEARANCE_COLORS[hash % FOLDER_APPEARANCE_COLORS.length];
}

export function getFolderAppearance(folder: {
  appearanceColor?: string | null;
  appearanceIcon?: FolderAppearanceIcon | null;
  displayName: string;
  path: string;
}) {
  return {
    color: folder.appearanceColor || getAutomaticFolderColor(folder.path),
    icon: folder.appearanceIcon,
    initial: getFolderInitial(folder.displayName),
  };
}
