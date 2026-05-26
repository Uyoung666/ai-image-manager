/**
 * Map i18n language key ("zh" | "en") to a BCP 47 locale string suitable
 * for toLocaleDateString() and the HTML lang attribute.
 */
export function getDateLocale(i18nLang: string): string {
  return i18nLang === "en" ? "en-US" : "zh-CN";
}
