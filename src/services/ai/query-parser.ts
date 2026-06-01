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

// 获取合并后的词典（包含用户自定义）
function getMergedDict() {
  try {
    return getDictionaryManager().getMergedDictionary();
  } catch {
    // 降级到内置词典
    return ZH_TO_EN_SEARCH;
  }
}

// Sort dictionary keys by length descending for greedy matching
function getSortedDictKeys() {
  return Object.keys(getMergedDict()).sort((a, b) => b.length - a.length);
}

export function parseChineseQuery(query: string): ParsedQuery {
  const dict = getMergedDict();
  const sortedKeys = getSortedDictKeys();

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
      remaining = remaining.replaceAll(key, " ");
    }
  }

  // Character-level decomposition for remaining CJK characters
  const remainingChars = remaining.replace(/\s+/g, "");
  if (remainingChars.length > 0) {
    for (const char of remainingChars) {
      if (/[一-鿿]/.test(char) && CHAR_DECOMPOSE[char]) {
        const entry = CHAR_DECOMPOSE[char];
        const slot = CATEGORY_TO_SLOT[entry.category as DictCategory];
        parsed[slot].push(char);
      } else if (/[一-鿿]/.test(char)) {
        parsed.unknown.push(char);
      }
      // Non-CJK characters (English, numbers) are ignored here
    }
  }

  return parsed;
}

function translateTerm(term: string): string {
  const dict = getMergedDict();
  const dictEntry = dict[term];
  if (dictEntry) {
    return dictEntry.en;
  }
  const charEntry = CHAR_DECOMPOSE[term];
  if (charEntry) {
    return charEntry.en;
  }
  return "";
}

function translateSlot(terms: string[]): string {
  const translated = terms.map(translateTerm).filter(Boolean);
  // Deduplicate words across translations
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const phrase of translated) {
    for (const word of phrase.split(/\s+/)) {
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

  // Fallback: if no prompts generated, use raw translation of all terms
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

// 计算中文查询中被词典覆盖的字符比例（0.0~1.0）
// 用于自适应调整向量搜索的余弦距离阈值：覆盖率越低，阈值越严格
export function getQueryCoverage(query: string, parsed: ParsedQuery): number {
  const trimmed = query.trim();
  const chineseChars = trimmed.replace(/[^一-鿿]/g, "");
  if (chineseChars.length === 0) {
    return 1.0; // 无中文，视为完全覆盖
  }

  const unknownChars = new Set(parsed.unknown);
  let uncoveredCount = 0;
  for (const char of chineseChars) {
    if (unknownChars.has(char)) {
      uncoveredCount++;
    }
  }
  return Math.max(0, 1 - uncoveredCount / chineseChars.length);
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
    }
  }
  return undefined;
}
