/**
 * 进度条趣味短语工具。
 * 短语内容统一存放在 i18n 翻译文件中，此处只负责随机取出一条。
 */

import i18n from "@/localization/i18n";

/** 每次调用返回当前 phase 对应语言的一条随机短语。 */
export function getRandomPhrase(phase: string): string {
  const key = `progressPhrases.${phase}`;
  const pool = i18n.t(key, { returnObjects: true }) as string[] | undefined;

  if (!pool || pool.length === 0) {
    const fallback = i18n.t("progressPhrases._fallback", {
      returnObjects: true,
    }) as string[];
    if (Array.isArray(fallback) && fallback.length > 0) {
      return fallback[Math.floor(Math.random() * fallback.length)];
    }
    return "";
  }

  return pool[Math.floor(Math.random() * pool.length)];
}
