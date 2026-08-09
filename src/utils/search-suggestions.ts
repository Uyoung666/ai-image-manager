import { ZH_TO_EN_SEARCH } from "@/services/ai/zh-en-dict";
import { Trie } from "./trie";

// 简化的拼音映射（首字母）
const PINYIN_INITIAL: Record<string, string> = {
  猫: "m",
  狗: "g",
  鸟: "n",
  鱼: "y",
  花: "h",
  树: "s",
  山: "s",
  水: "s",
  海: "h",
  天: "t",
  云: "y",
  人: "r",
  车: "c",
  船: "c",
  飞: "f",
  // 可以继续扩展更多常用字
};

let cachedTrie: Trie | null = null;
let cachedPinyinMap: Map<string, string[]> | null = null;
let cachedPersonTrie: Trie | null = null;

// 构建词典 Trie 树（懒加载）
export function getDictionaryTrie(): Trie {
  if (cachedTrie) {
    return cachedTrie;
  }

  const trie = new Trie();

  // 插入所有词条
  for (const [word, entry] of Object.entries(ZH_TO_EN_SEARCH)) {
    trie.insert(word, entry.category, entry.en);
  }

  cachedTrie = trie;
  return trie;
}

// 构建人物名 Trie 树
export function buildPersonTrie(personNames: string[]): Trie {
  const trie = new Trie();
  for (const name of personNames) {
    if (name.trim()) {
      trie.insert(name.trim(), "person", name.trim());
    }
  }
  cachedPersonTrie = trie;
  return trie;
}

export function getCachedPersonTrie(): Trie | null {
  return cachedPersonTrie;
}

// 获取拼音首字母映射
export function getPinyinMap(): Map<string, string[]> {
  if (cachedPinyinMap) {
    return cachedPinyinMap;
  }

  const map = new Map<string, string[]>();

  for (const word of Object.keys(ZH_TO_EN_SEARCH)) {
    // 生成拼音首字母
    let pinyin = "";
    for (const char of word) {
      const initial = PINYIN_INITIAL[char];
      if (initial) {
        pinyin += initial;
      }
    }

    if (pinyin) {
      if (!map.has(pinyin)) {
        map.set(pinyin, []);
      }
      map.get(pinyin)?.push(word);
    }
  }

  cachedPinyinMap = map;
  return map;
}

export interface SearchSuggestion {
  category?: string;
  matchType: "prefix" | "pinyin" | "person";
  translation?: string;
  word: string;
}

// 预编译正则
const ALPHA_ONLY = /^[a-z]+$/;

// 生成搜索建议（支持中文前缀、拼音首字母和人物名）
export function getSearchSuggestions(
  input: string,
  limit = 10
): SearchSuggestion[] {
  if (!input || input.length === 0) {
    return [];
  }

  const trie = getDictionaryTrie();
  const personTrie = getCachedPersonTrie();
  const pinyinMap = getPinyinMap();
  const results: SearchSuggestion[] = [];

  const isAlphaInput = ALPHA_ONLY.test(input.toLowerCase());

  // 1. 人物名前缀匹配（最高优先级，中文输入需要 >=2 字符）
  if (personTrie && !isAlphaInput && input.length >= 2) {
    const personMatches = personTrie.search(input, 3);
    for (const match of personMatches) {
      results.push({
        word: match.word,
        category: "person",
        matchType: "person",
        translation: match.translation,
      });
    }
  }

  // 2. 中文前缀匹配（需要 >=2 字符）
  if (!isAlphaInput && input.length >= 2) {
    const remaining = limit - results.length;
    const prefixMatches = trie.search(input, remaining);
    for (const match of prefixMatches) {
      results.push({
        ...match,
        matchType: "prefix",
      });
    }
  }

  // 3. 拼音首字母匹配（允许单字符，如 "h" → "海"）
  if (isAlphaInput && results.length < limit) {
    const pinyinWords = pinyinMap.get(input.toLowerCase()) || [];
    for (const word of pinyinWords.slice(0, limit - results.length)) {
      const entry = ZH_TO_EN_SEARCH[word];
      if (entry) {
        results.push({
          word,
          category: entry.category,
          translation: entry.en,
          matchType: "pinyin",
        });
      }
    }
  }

  return results;
}

// 获取分类的中文名称
export function getCategoryLabel(category?: string): string {
  const labels: Record<string, string> = {
    subject: "主体",
    scene: "场景",
    time: "时间",
    style: "风格",
    activity: "活动",
    color: "颜色",
    weather: "天气",
    object: "物体",
    person: "人物",
  };
  return category ? labels[category] || category : "";
}
