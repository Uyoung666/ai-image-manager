import { getDictionaryManager } from "../dictionary-manager";
import {
  CHAR_DECOMPOSE,
  type DictCategory,
  ZH_TO_EN_SEARCH,
} from "./zh-en-dict";

export interface ParsedQuery {
  activity: string[];
  color: string[];
  scene: string[];
  style: string[];
  subject: string[];
  time: string[];
  unknown: string[];
  weather: string[];
}

export interface ScoringOptions {
  temporalBoost?: {
    targetFrom: number;
    targetTo: number;
    factor: number;
  };
  timeDecay?: {
    enabled: boolean;
    alpha: number;
    maxAgeMs: number;
  };
}

const CATEGORY_TO_SLOT: Record<DictCategory, keyof ParsedQuery> = {
  subject: "subject",
  scene: "scene",
  time: "time",
  style: "style",
  activity: "activity",
  color: "color",
  weather: "weather",
  object: "subject",
};

const CJK_FRAGMENT_RE = /[一-鿿]+/g;
const WHITESPACE_RE = /\s+/g;
const MATCHED_TERM_BOUNDARY = "\0";
const MATCHED_COLOR_BOUNDARY = "\u0001";

function getMergedDict() {
  try {
    return getDictionaryManager().getMergedDictionary();
  } catch {
    return ZH_TO_EN_SEARCH;
  }
}

function getCharDictionary() {
  try {
    return getDictionaryManager().getCharDecompose();
  } catch {
    return CHAR_DECOMPOSE;
  }
}

function getDisabledEntries(): ReadonlySet<string> {
  try {
    return getDictionaryManager().getDisabledEntries();
  } catch {
    return new Set();
  }
}

export function parseChineseQuery(query: string): ParsedQuery {
  const dict = getMergedDict();
  const chars = getCharDictionary();
  const disabled = getDisabledEntries();
  const sortedKeys = Object.keys(dict)
    .filter((key) => key.length > 1)
    .sort((a, b) => b.length - a.length);

  const parsed: ParsedQuery = {
    subject: [],
    scene: [],
    time: [],
    style: [],
    activity: [],
    color: [],
    weather: [],
    unknown: [],
  };

  let remaining = query.trim();

  // Greedy match: longest dictionary entries first
  for (const key of sortedKeys) {
    if (remaining.includes(key)) {
      const entry = dict[key];
      const slot = CATEGORY_TO_SLOT[entry.category];
      parsed[slot].push(key);
      remaining = remaining.replaceAll(
        key,
        entry.category === "color"
          ? MATCHED_COLOR_BOUNDARY
          : MATCHED_TERM_BOUNDARY
      );
    }
  }

  // Unknown compounds are not bags of visual characters. Known word matches
  // keep a distinct boundary so they cannot turn 老相机 into elderly + camera.
  for (const match of remaining.matchAll(CJK_FRAGMENT_RE)) {
    const fragment = match[0];
    const leftBoundary = remaining[match.index - 1];
    const rightBoundary = remaining[match.index + fragment.length];
    const leftKnown = isKnownTermBoundary(leftBoundary);
    const rightKnown = isKnownTermBoundary(rightBoundary);
    const terms = [...fragment.matchAll(CJK_CONTENT_TERM_RE)];
    if (terms.length === 0) {
      continue;
    }
    const characters = terms.map((term) => {
      const directlyLeft = term.index === 0 && leftKnown;
      const directlyRight =
        term.index + term[0].length === fragment.length && rightKnown;
      return getBoundedCharacters(
        term[0],
        dict,
        chars,
        disabled,
        directlyLeft || directlyRight,
        directlyLeft && leftBoundary === MATCHED_COLOR_BOUNDARY
      );
    });
    // A function word inside an unknown compound is not evidence of a word
    // boundary (e.g. 也门 or 沙有发). Accept only completely recognized phrases.
    if (
      (CJK_GRAMMAR_BOUNDARIES.has(fragment[0]) && !leftKnown) ||
      (CJK_GRAMMAR_BOUNDARIES.has(fragment.at(-1) ?? "") && !rightKnown) ||
      CONSECUTIVE_GRAMMAR_BOUNDARY_RE.test(fragment) ||
      characters.some((words) => words === null)
    ) {
      parsed.unknown.push(...fragment);
      continue;
    }
    for (const char of characters.flat()) {
      if (char) {
        parsed[CATEGORY_TO_SLOT[chars[char].category]].push(char);
      }
    }
  }

  return parsed;
}

function isKnownTermBoundary(char: string | undefined): boolean {
  return char === MATCHED_TERM_BOUNDARY || char === MATCHED_COLOR_BOUNDARY;
}

function getBoundedCharacters(
  term: string,
  dict: ReturnType<typeof getMergedDict>,
  chars: ReturnType<typeof getCharDictionary>,
  disabled: ReadonlySet<string>,
  adjacentKnownWord: boolean,
  followsExplicitColor: boolean
): string[] | null {
  if (disabled.has(term)) {
    return null;
  }
  if (term.length === 1 && chars[term]) {
    // A complete color word supplies an explicit modifier boundary (红色猫).
    // Bare compounds (红猫/红包) never get decomposed below.
    const explicitColorNoun =
      followsExplicitColor &&
      dict[term] &&
      ["subject", "object", "scene"].includes(dict[term].category);
    return !adjacentKnownWord ||
      explicitColorNoun ||
      chars[term].category === "color"
      ? [term]
      : null;
  }
  return null;
}

export function translateQueryTerm(term: string): string {
  const dict = getMergedDict();
  const dictEntry = dict[term];
  if (dictEntry) {
    return dictEntry.en;
  }
  const charEntry = getCharDictionary()[term];
  if (charEntry) {
    return charEntry.en;
  }
  return "";
}

function translateSlot(terms: string[]): string {
  const translated = terms.map(translateQueryTerm).filter(Boolean);
  // Deduplicate words across translations
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const phrase of translated) {
    for (const word of phrase.split(WHITESPACE_RE)) {
      const lower = word.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        unique.push(word);
      }
    }
  }
  return unique.join(" ");
}

export function generateSearchPrompts(parsed: ParsedQuery): string[] {
  const prompts: string[] = [];

  // Prompt 1: Full natural language description combining all slots
  const parts: string[] = [];
  if (parsed.style.length > 0) {
    parts.push(translateSlot(parsed.style));
  }
  if (parsed.subject.length > 0) {
    parts.push(translateSlot(parsed.subject));
  }
  if (parsed.activity.length > 0) {
    parts.push(translateSlot(parsed.activity));
  }
  if (parsed.scene.length > 0) {
    parts.push(`at ${translateSlot(parsed.scene)}`);
  }
  if (parsed.weather.length > 0) {
    parts.push(`in ${translateSlot(parsed.weather)}`);
  }
  if (parsed.time.length > 0) {
    parts.push(`during ${translateSlot(parsed.time)}`);
  }
  if (parsed.color.length > 0) {
    parts.push(translateSlot(parsed.color));
  }

  if (parts.length > 0) {
    prompts.push(`a photo of ${parts.join(" ")}`);
  }

  // Prompt 2: Subject-focused (if subject exists and there are other slots)
  if (
    parsed.subject.length > 0 &&
    (parsed.scene.length > 0 || parsed.activity.length > 0)
  ) {
    prompts.push(`a photograph of ${translateSlot(parsed.subject)}`);
  }

  // Prompt 3: Scene-focused (if scene exists and there's also a subject)
  if (parsed.scene.length > 0 && parsed.subject.length > 0) {
    prompts.push(`a scenic photo at ${translateSlot(parsed.scene)}`);
  }

  // Fallback: if no structured prompts generated, use raw translation of all terms
  if (prompts.length === 0) {
    const allTerms = [
      ...parsed.subject,
      ...parsed.scene,
      ...parsed.time,
      ...parsed.style,
      ...parsed.activity,
      ...parsed.color,
      ...parsed.weather,
    ];
    const raw = translateSlot(allTerms);
    if (raw) {
      prompts.push(`a photo of ${raw}`);
    }
  }

  return prompts;
}

const CJK_FUNCTION_WORDS = new Set([
  "的",
  "了",
  "着",
  "过",
  "地",
  "得",
  "吗",
  "呢",
  "吧",
  "啊",
  "呀",
  "嘛",
  "和",
  "与",
  "或",
  "及",
  "等",
  "在",
  "是",
  "有",
  "这",
  "那",
  "也",
]);
// Coverage stopwords are not word boundaries: e.g. 也 is part of 也门.
// Even these grammar characters can belong to a word, so adjacent separators
// cannot prove independent terms (猫在和田 must not produce a field prompt).
const CJK_GRAMMAR_BOUNDARIES = new Set(["的", "和", "与", "或", "及", "在"]);
const CJK_CONTENT_TERM_RE = /[^的和与或及在]+/g;
const CONSECUTIVE_GRAMMAR_BOUNDARY_RE = /[的和与或及在]{2,}/;

// 计算中文查询中被词典覆盖的字符比例（0.0~1.0）。
// 覆盖率仅用于诊断与降级说明，不再用于插值调整 SigLIP 阈值。
export function getQueryCoverage(query: string, parsed: ParsedQuery): number {
  const trimmed = query.trim();
  // 只统计有意义的中文字符（排除虚词）
  const chineseChars = trimmed.replace(/[^一-鿿]/g, "");
  const meaningfulChars = [...chineseChars].filter(
    (c) => !CJK_FUNCTION_WORDS.has(c)
  );
  if (meaningfulChars.length === 0) {
    return 1.0; // 只有虚词，视为完全覆盖
  }

  // Unknown occurrences are already preserved by the parser. A character that
  // also appears in a known word must not make that known occurrence unknown.
  const uncoveredCount = parsed.unknown.filter(
    (char) => !CJK_FUNCTION_WORDS.has(char)
  ).length;
  return Math.max(0, 1 - uncoveredCount / meaningfulChars.length);
}

export function extractTemporalContext(
  parsed: ParsedQuery
): ScoringOptions["temporalBoost"] | undefined {
  if (parsed.time.length === 0) {
    return undefined;
  }

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();

  for (const timeWord of parsed.time) {
    switch (timeWord) {
      case "去年":
        return {
          targetFrom: new Date(year - 1, 0, 1).getTime(),
          targetTo: new Date(year - 1, 11, 31).getTime(),
          factor: 1.4,
        };
      case "今年":
        return {
          targetFrom: new Date(year, 0, 1).getTime(),
          targetTo: now.getTime(),
          factor: 1.3,
        };
      case "秋天": {
        const autumnYear = month >= 9 ? year : year - 1;
        return {
          targetFrom: new Date(autumnYear, 8, 1).getTime(),
          targetTo: new Date(autumnYear, 10, 30).getTime(),
          factor: 1.4,
        };
      }
      case "春天": {
        const springYear = month >= 3 ? year : year - 1;
        return {
          targetFrom: new Date(springYear, 2, 1).getTime(),
          targetTo: new Date(springYear, 4, 31).getTime(),
          factor: 1.4,
        };
      }
      case "夏天": {
        const summerYear = month >= 6 ? year : year - 1;
        return {
          targetFrom: new Date(summerYear, 5, 1).getTime(),
          targetTo: new Date(summerYear, 7, 31).getTime(),
          factor: 1.4,
        };
      }
      case "冬天": {
        const winterStart = month <= 2 ? year - 1 : year;
        return {
          targetFrom: new Date(winterStart, 11, 1).getTime(),
          targetTo: new Date(winterStart + 1, 1, 28).getTime(),
          factor: 1.4,
        };
      }
      case "昨天": {
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        yesterday.setHours(0, 0, 0, 0);
        const yesterdayEnd = new Date(yesterday);
        yesterdayEnd.setHours(23, 59, 59, 999);
        return {
          targetFrom: yesterday.getTime(),
          targetTo: yesterdayEnd.getTime(),
          factor: 1.5,
        };
      }
      case "上周": {
        const weekAgo = new Date(now);
        weekAgo.setDate(weekAgo.getDate() - 7);
        return {
          targetFrom: weekAgo.getTime(),
          targetTo: now.getTime(),
          factor: 1.3,
        };
      }
      default:
        break;
    }
  }
  return undefined;
}
