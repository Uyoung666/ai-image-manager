import type { ChangelogEntry, ChangelogLocale, LocalizedText } from "./types";
import initial from "./v2.0.0";
import previous from "./v2.1.0";
import current from "./v2.1.1";

export type { ChangelogEntry, ChangelogLocale, LocalizedText } from "./types";

export const changelogEntries: ChangelogEntry[] = [current, previous, initial];

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
