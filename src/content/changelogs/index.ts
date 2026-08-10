import type { ChangelogEntry, ChangelogLocale, LocalizedText } from "./types";
import current from "./v2.0.0";

export type { ChangelogEntry, ChangelogLocale, LocalizedText } from "./types";

export const changelogEntries: ChangelogEntry[] = [current];

export function getChangelog(version?: string): ChangelogEntry | undefined {
  if (!version) {
    return undefined;
  }
  return changelogEntries.find((entry) => entry.version === version);
}

export function getLatestChangelog(): ChangelogEntry | undefined {
  return changelogEntries[0];
}

export function hasChangelog(version: string): boolean {
  return Boolean(getChangelog(version));
}

export function getLocalizedText(
  text: LocalizedText,
  language: string
): string {
  const locale: ChangelogLocale = language.toLowerCase().startsWith("zh")
    ? "zh"
    : "en";
  return text[locale] || text.zh;
}
