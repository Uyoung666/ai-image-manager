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

// 时间表达式映射
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
      cleaned =
        cleaned.slice(0, idx) + " " + cleaned.slice(idx + phrase.length);
      idx = cleaned.indexOf(phrase);
    }
  }

  // 移除独立停用词（每个字符独立判断，避免合并有意义词）
  const chars = [...cleaned];
  const filtered = chars.filter((c) => !STOP_WORDS.has(c));
  cleaned = filtered.join("");

  return { cleaned: cleaned.trim(), removed };
}

// 解析时间表达式 — 保留时间词在查询中（对 CLIP 语义搜索有意义）
function parseTimeExpression(query: string): {
  timeFilter?: { from: number; to: number };
} {
  const now = new Date();

  // 按长度降序检测（避免 "上个月" 被 "上月" 或 "月" 误匹配）
  const sorted = Object.entries(TIME_EXPRESSIONS).sort(
    (a, b) => b[0].length - a[0].length
  );

  for (const [expr, getRange] of sorted) {
    if (query.includes(expr)) {
      return { timeFilter: getRange(now) };
    }
  }

  return {};
}

// 查询改写主函数
export function rewriteQuery(query: string): RewrittenQuery {
  const originalQuery = query.trim();

  const { timeFilter } = parseTimeExpression(originalQuery);

  const { cleaned: afterColloquial, removed: removedTerms } =
    removeColloquialisms(originalQuery);

  let cleanQuery = afterColloquial.replace(/\s+/g, " ").trim();

  if (cleanQuery && timeFilter) {
    let isPureTime = Object.keys(TIME_EXPRESSIONS).some(
      (e) => cleanQuery === e
    );
    if (!isPureTime) {
      let testQuery = cleanQuery;
      for (const expr of Object.keys(TIME_EXPRESSIONS)) {
        testQuery = testQuery.replace(new RegExp(expr, "g"), " ").trim();
      }
      isPureTime = !testQuery;
    }
    if (isPureTime) {
      cleanQuery = "";
    }
  }

  return { cleanQuery, originalQuery, timeFilter, removedTerms };
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
