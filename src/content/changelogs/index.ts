import type { ChangelogEntry, ChangelogLocale, LocalizedText } from "./types";
import initial from "./v2.0.0";
import previous from "./v2.1.0";
import previousPatch from "./v2.1.1";
import previousMinor from "./v2.2.0";
import previousMinorPatch from "./v2.2.1";
import previousRelease from "./v2.2.2";
import previousReleasePatch from "./v2.2.3";
import previousStable from "./v2.2.4";
import previousStablePatch from "./v2.2.5";
import current from "./v2.2.6";

export type { ChangelogEntry, ChangelogLocale, LocalizedText } from "./types";

export const changelogEntries: ChangelogEntry[] = [
  current,
  previousStablePatch,
  previousStable,
  previousReleasePatch,
  previousRelease,
  previousMinorPatch,
  previousMinor,
  previousPatch,
  previous,
  initial,
];

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
