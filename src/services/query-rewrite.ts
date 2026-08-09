// 查询改写和标准化

// 口语化词组 — 按长度降序，前部放更具体的组合（先匹配更长的模式）
const COLLOQUIAL_PHRASES = [
  "帮我找",
  "找一下",
  "有没有",
  "查一下",
  // 摄影动作+照片组合 — 必须排在 "的照片" 前面，先吃掉 "拍"
  "拍的照片",
  "拍的图片",
  "照的照片",
  "拍的相片",
  "照的图片",
  "拍照",
  "拍",
  "照",
  "的照片",
  "的图片",
  "的相片",
  "搜索",
  "看看",
  "帮我",
  "找找",
  "找",
];

// 独立的虚词／停用词：在去除词组后再逐字移除
const STOP_WORDS = new Set([
  "的",
  "了",
  "着",
  "过",
  "吗",
  "呢",
  "吧",
  "啊",
  "呀",
  "嘛",
]);

// ── 动态时间表达式正则引擎 ──────────────────────────────────────────
// 替代纯硬编码字符串匹配，支持灵活的自然语言时间描述

interface DynamicTimeRange {
  /** 匹配到的原始文本（用于从查询中移除） */
  matchedText: string;
  /** 提取到的时间范围 */
  timeFilter: { from: number; to: number };
}

// 相对时间：N天前 / N周前 / N个月前 / N年前 / 过去N天 等
const RELATIVE_TIME_RE =
  /(?:前|过去)\s*(\d+)\s*(天|周|个?月|年)|(\d+)\s*(天|周|个?月|年)\s*(?:前|之前|以前)/;

// 绝对时间：2024年 / 2024年3月 / 2024年3月15日 / 3月15日 等
const ABSOLUTE_DATE_RE =
  /(\d{4})\s*[年/\-.]\s*(\d{1,2})\s*(?:[月/\-.]\s*(\d{1,2})\s*[日号]?)?/;

// 口语化季节+年份组合：去年夏天 / 2024年春天 等
const YEAR_QUALIFIED_SEASON_RE =
  /(去年|今年|明年|前年|(\d{4})\s*年)\s*(春天|夏天|秋天|冬天|春季|夏季|秋季|冬季)/;

// 纯季节（无年份限定）
const BARE_SEASON_RE = /(春天|夏天|秋天|冬天|春季|夏季|秋季|冬季)/;

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Dynamic time parsing keeps relative, absolute, and seasonal syntax resolution ordered.
function parseDynamicTime(query: string, now: Date): DynamicTimeRange | null {
  // 1. 尝试相对时间（N天前/周前等）
  const relMatch = RELATIVE_TIME_RE.exec(query);
  if (relMatch) {
    const num = Number.parseInt(relMatch[1] || relMatch[3], 10);
    const unit = relMatch[2] || relMatch[4];
    if (num > 0 && num <= 3650) {
      // 10年上限，防止异常输入
      return buildRelativeRange(num, unit, now, relMatch[0]);
    }
  }

  // 2. 尝试年份限定季节（去年夏天 / 2024年春天）
  const seasonYearMatch = YEAR_QUALIFIED_SEASON_RE.exec(query);
  if (seasonYearMatch) {
    const yearQualifier = seasonYearMatch[1];
    const explicitYear = seasonYearMatch[2];
    const season = seasonYearMatch[3];
    const resolvedYear = resolveYearQualifier(yearQualifier, explicitYear, now);
    return buildSeasonRange(season, resolvedYear, seasonYearMatch[0]);
  }

  // 3. 尝试绝对日期（2024年3月 / 2024年3月15日 / 3月15日）
  const absMatch = ABSOLUTE_DATE_RE.exec(query);
  if (absMatch) {
    const year = Number.parseInt(absMatch[1], 10);
    const month = Number.parseInt(absMatch[2], 10) - 1; // 0-indexed
    const day = absMatch[3] ? Number.parseInt(absMatch[3], 10) : undefined;

    if (month >= 0 && month <= 11 && year >= 1970 && year <= 2100) {
      if (day !== undefined && (day < 1 || day > 31)) {
        return null; // invalid day
      }
      const from = new Date(year, month, day ?? 1, 0, 0, 0, 0);
      let to: Date;
      if (day === undefined) {
        // 只有年月 → 到月末
        to = new Date(year, month + 1, 0, 23, 59, 59, 999);
      } else {
        to = new Date(year, month, day, 23, 59, 59, 999);
      }
      return {
        timeFilter: { from: from.getTime(), to: to.getTime() },
        matchedText: absMatch[0],
      };
    }
  }

  // 4. 尝试裸季节（在当前上下文推断年份）
  const seasonMatch = BARE_SEASON_RE.exec(query);
  if (seasonMatch) {
    const season = seasonMatch[1];
    const inferredYear = inferSeasonYear(season, now);
    return buildSeasonRange(season, inferredYear, seasonMatch[0]);
  }

  return null;
}

function buildRelativeRange(
  num: number,
  unit: string,
  now: Date,
  matchedText: string
): DynamicTimeRange {
  const to = new Date(now);
  to.setHours(23, 59, 59, 999);
  const from = new Date(to);

  switch (unit) {
    case "天":
      from.setDate(from.getDate() - num);
      from.setHours(0, 0, 0, 0);
      break;
    case "周":
      from.setDate(from.getDate() - num * 7);
      from.setHours(0, 0, 0, 0);
      break;
    case "个月":
    case "月":
      from.setMonth(from.getMonth() - num);
      from.setHours(0, 0, 0, 0);
      break;
    case "年":
      from.setFullYear(from.getFullYear() - num);
      from.setHours(0, 0, 0, 0);
      break;
    default:
      from.setDate(from.getDate() - num);
      from.setHours(0, 0, 0, 0);
  }

  return {
    timeFilter: { from: from.getTime(), to: to.getTime() },
    matchedText,
  };
}

function resolveYearQualifier(
  qualifier: string,
  explicitYear: string | undefined,
  now: Date
): number {
  if (explicitYear) {
    return Number.parseInt(explicitYear, 10);
  }
  switch (qualifier) {
    case "去年":
      return now.getFullYear() - 1;
    case "明年":
      return now.getFullYear() + 1;
    case "前年":
      return now.getFullYear() - 2;
    default:
      return now.getFullYear();
  }
}

function inferSeasonYear(season: string, now: Date): number {
  const month = now.getMonth();
  const seasonStartMonths: Record<string, number> = {
    春: 2,
    春天: 2,
    春季: 2,
    夏: 5,
    夏天: 5,
    夏季: 5,
    秋: 8,
    秋天: 8,
    秋季: 8,
    冬: 11,
    冬天: 11,
    冬季: 11,
  };
  const startMonth = seasonStartMonths[season] ?? 0;
  // 如果当前月份 >= 季节开始月份，用今年；否则用去年
  return month >= startMonth ? now.getFullYear() : now.getFullYear() - 1;
}

function buildSeasonRange(
  season: string,
  year: number,
  matchedText: string
): DynamicTimeRange | null {
  const seasonMonths: Record<string, [number, number]> = {
    春: [2, 4],
    春天: [2, 4],
    春季: [2, 4],
    夏: [5, 7],
    夏天: [5, 7],
    夏季: [5, 7],
    秋: [8, 10],
    秋天: [8, 10],
    秋季: [8, 10],
    冬: [11, 13],
    冬天: [11, 13],
    冬季: [11, 13], // 13 → 次年1月
  };
  const [startMonth, endMonth] = seasonMonths[season] ?? [0, 2];
  const from = new Date(year, startMonth, 1, 0, 0, 0, 0);
  let to: Date;
  if (endMonth > 11) {
    // 冬季跨年
    to = new Date(year + 1, endMonth - 12, 0, 23, 59, 59, 999);
  } else {
    to = new Date(year, endMonth + 1, 0, 23, 59, 59, 999);
  }
  return {
    timeFilter: { from: from.getTime(), to: to.getTime() },
    matchedText,
  };
}

// ── 静态时间表达式映射（兜底精确短词） ──────────────────────────────

const TIME_EXPRESSIONS: Record<
  string,
  (now: Date) => { from: number; to: number }
> = {
  今天: (now) => {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    return { from: start.getTime(), to: end.getTime() };
  },
  昨天: (now) => {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    const end = new Date(yesterday);
    end.setHours(23, 59, 59, 999);
    return { from: yesterday.getTime(), to: end.getTime() };
  },
  前天: (now) => {
    const dayBefore = new Date(now);
    dayBefore.setDate(dayBefore.getDate() - 2);
    dayBefore.setHours(0, 0, 0, 0);
    const end = new Date(dayBefore);
    end.setHours(23, 59, 59, 999);
    return { from: dayBefore.getTime(), to: end.getTime() };
  },
  上周: (now) => {
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);
    weekAgo.setHours(0, 0, 0, 0);
    return { from: weekAgo.getTime(), to: now.getTime() };
  },
  上周末: (now) => {
    const lastSaturday = new Date(now);
    const dayOfWeek = now.getDay();
    const daysToLastSaturday = dayOfWeek === 0 ? 8 : dayOfWeek + 1;
    lastSaturday.setDate(now.getDate() - daysToLastSaturday);
    lastSaturday.setHours(0, 0, 0, 0);

    const lastSunday = new Date(lastSaturday);
    lastSunday.setDate(lastSaturday.getDate() + 1);
    lastSunday.setHours(23, 59, 59, 999);

    return { from: lastSaturday.getTime(), to: lastSunday.getTime() };
  },
  本周: (now) => {
    const startOfWeek = new Date(now);
    const dayOfWeek = now.getDay();
    const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    startOfWeek.setDate(now.getDate() - diff);
    startOfWeek.setHours(0, 0, 0, 0);
    return { from: startOfWeek.getTime(), to: now.getTime() };
  },
  上个月: (now) => {
    const lastMonth = new Date(now);
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    lastMonth.setDate(1);
    lastMonth.setHours(0, 0, 0, 0);

    const endOfLastMonth = new Date(now);
    endOfLastMonth.setDate(0);
    endOfLastMonth.setHours(23, 59, 59, 999);

    return { from: lastMonth.getTime(), to: endOfLastMonth.getTime() };
  },
  本月: (now) => {
    const startOfMonth = new Date(now);
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    return { from: startOfMonth.getTime(), to: now.getTime() };
  },
  今年: (now) => {
    const startOfYear = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
    return { from: startOfYear.getTime(), to: now.getTime() };
  },
  去年: (now) => {
    const lastYear = now.getFullYear() - 1;
    const startOfLastYear = new Date(lastYear, 0, 1, 0, 0, 0, 0);
    const endOfLastYear = new Date(lastYear, 11, 31, 23, 59, 59, 999);
    return { from: startOfLastYear.getTime(), to: endOfLastYear.getTime() };
  },
};

export interface RewrittenQuery {
  cleanQuery: string; // 清理后的查询
  originalQuery: string; // 原始查询
  removedTerms: string[]; // 移除的口语化词汇
  timeFilter?: { from: number; to: number }; // 解析出的时间筛选
  /** 动态时间匹配的原始文本（用于从查询中移除） */
  timeMatchedText?: string;
}

// 去除口语化表达（单次扫描，避免顺序依赖）
function removeColloquialisms(query: string): {
  cleaned: string;
  removed: string[];
} {
  let cleaned = query;
  const removed: string[] = [];

  // 按长度降序逐段移除，每次从原始位置查找
  for (const phrase of COLLOQUIAL_PHRASES) {
    let idx = cleaned.indexOf(phrase);
    while (idx !== -1) {
      removed.push(phrase);
      cleaned = `${cleaned.slice(0, idx)} ${cleaned.slice(idx + phrase.length)}`;
      idx = cleaned.indexOf(phrase);
    }
  }

  // 移除独立停用词（每个字符独立判断，避免合并有意义词）
  const chars = [...cleaned];
  const filtered = chars.filter((c) => !STOP_WORDS.has(c));
  cleaned = filtered.join("");

  return { cleaned: cleaned.trim(), removed };
}

// 解析时间表达式 — 优先动态正则，再回退静态词典
function parseTimeExpression(query: string): {
  timeFilter?: { from: number; to: number };
  matchedText?: string;
} {
  const now = new Date();

  // 1. 优先尝试动态正则引擎（覆盖范围远超静态词典）
  const dynamic = parseDynamicTime(query, now);
  if (dynamic) {
    return {
      timeFilter: dynamic.timeFilter,
      matchedText: dynamic.matchedText,
    };
  }

  // 2. 回退到静态词典（精确短词如"今天""昨天"）
  const sorted = Object.entries(TIME_EXPRESSIONS).sort(
    (a, b) => b[0].length - a[0].length
  );

  for (const [expr, getRange] of sorted) {
    if (query.includes(expr)) {
      return { timeFilter: getRange(now), matchedText: expr };
    }
  }

  return {};
}

// 查询改写主函数
// ── LRU cache for rewriteQuery results (纯计算, 无副作用) ─────────────
const rewriteCache = new Map<string, { result: RewrittenQuery; ts: number }>();
const REWRITE_CACHE_TTL = 2 * 60 * 1000; // 2 minutes
const MAX_REWRITE_CACHE = 50;

function getCachedRewrite(key: string): RewrittenQuery | null {
  const entry = rewriteCache.get(key);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.ts > REWRITE_CACHE_TTL) {
    rewriteCache.delete(key);
    return null;
  }
  // LRU bump
  rewriteCache.delete(key);
  rewriteCache.set(key, entry);
  return entry.result;
}

function setCachedRewrite(key: string, result: RewrittenQuery): void {
  if (rewriteCache.size >= MAX_REWRITE_CACHE) {
    const lru = rewriteCache.keys().next().value;
    if (lru !== undefined) {
      rewriteCache.delete(lru);
    }
  }
  rewriteCache.set(key, { result, ts: Date.now() });
}

export function rewriteQuery(query: string): RewrittenQuery {
  const cacheKey = query.trim();
  const cached = getCachedRewrite(cacheKey);
  if (cached) {
    return cached;
  }

  const originalQuery = query.trim();

  // ── 关键顺序：先解析时间，再去除口语/停用词 ────────────────────
  // 停用词集包含 "过" 等字，会破坏 "过去2周"→"去2周" 的时间模式。
  // 必须在停用词移除之前，在原始查询上完成时间表达式匹配。

  // 1. 在原始查询上解析时间表达式（优先动态正则 → 回退静态词典）
  const { timeFilter, matchedText } = parseTimeExpression(originalQuery);

  // 2. 去除口语化表达和停用词
  const { cleaned: afterColloquial, removed: removedTerms } =
    removeColloquialisms(originalQuery);

  let cleanQuery = afterColloquial.replace(/\s+/g, " ").trim();

  // 3. 从 cleanQuery 中移除匹配到的时间文本
  if (matchedText && cleanQuery.includes(matchedText)) {
    cleanQuery = cleanQuery
      .replace(matchedText, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // 4. 如果 cleanQuery 只剩下时间词（纯时间查询），清空 cleanQuery
  if (cleanQuery && timeFilter) {
    let testQuery = cleanQuery;
    for (const expr of Object.keys(TIME_EXPRESSIONS)) {
      testQuery = testQuery.replace(new RegExp(expr, "g"), " ").trim();
    }
    if (testQuery) {
      const dynamicCheck = parseDynamicTime(testQuery, new Date());
      if (dynamicCheck) {
        testQuery = testQuery.replace(dynamicCheck.matchedText, " ").trim();
      }
    }
    if (!testQuery) {
      cleanQuery = "";
    }
  }

  const result: RewrittenQuery = {
    cleanQuery,
    originalQuery,
    timeFilter,
    removedTerms,
    timeMatchedText: matchedText,
  };
  setCachedRewrite(cacheKey, result);
  return result;
}

// 标准化 EXIF 筛选（将时间筛选转换为日期字符串）
export function timeFilterToDateRange(timeFilter: {
  from: number;
  to: number;
}): {
  dateFrom: string;
  dateTo: string;
} {
  const fromDate = new Date(timeFilter.from);
  const toDate = new Date(timeFilter.to);

  const dateFrom = `${fromDate.getFullYear()}-${String(fromDate.getMonth() + 1).padStart(2, "0")}-${String(fromDate.getDate()).padStart(2, "0")}`;
  const dateTo = `${toDate.getFullYear()}-${String(toDate.getMonth() + 1).padStart(2, "0")}-${String(toDate.getDate()).padStart(2, "0")}`;

  return { dateFrom, dateTo };
}
