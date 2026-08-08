export type ChangelogLocale = "zh" | "en";

export interface LocalizedText {
  en: string;
  zh: string;
}

export interface ChangelogHighlight {
  description: LocalizedText;
  icon: "image" | "layers" | "search" | "sparkles" | "zap";
  title: LocalizedText;
}

export interface ChangelogEntry {
  date: string;
  highlights: ChangelogHighlight[];
  summary: LocalizedText;
  title: LocalizedText;
  version: string;
}
