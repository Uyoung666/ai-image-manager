import { rewriteQuery } from "@/services/query-rewrite";
import {
  generateSearchPrompts,
  getQueryCoverage,
  parseChineseQuery,
} from "./query-parser";
import { translateChineseToEnglish } from "./translation-worker-client";

export const SEMANTIC_QUERY_PLAN_VERSION = 2;

const CJK_RE = /[一-鿿]/;
const LATIN_RE = /[A-Za-z]/;
const SEARCH_COMMAND_RE =
  /(?:帮我找|找一下|查一下|搜索一下|搜索|看看|找找|帮我|找)/g;
const PHOTO_SUFFIX_RE = /(?:的)?(?:照片|图片|相片|影像)$/;
const LEADING_NEGATIVE_AUX_RE = /^(?:有|着|是)/;
const QUOTE_PUNCTUATION_RE = /[“”"'（）()]/g;
const PHOTO_PROMPT_RE =
  /^(?:a|an|the|this)\s+(?:photo|photograph|picture|image)\b/i;
const LATIN_TERM_RE = /[A-Za-z][A-Za-z0-9_.-]*/g;
const QUOTED_CONTENT_RE = /["“]([^"”]+)["”]/g;

export type SemanticPromptRole = "primary" | "structured" | "focused";
export type SemanticQueryLanguage = "en" | "zh" | "mixed";
export type SemanticTranslationMode = "none" | "local" | "dictionary-fallback";

export interface SemanticQueryPrompt {
  role: SemanticPromptRole;
  text: string;
  weight: number;
}

export interface SemanticQueryPlan {
  coverage: number;
  language: SemanticQueryLanguage;
  negativePrompts: string[];
  normalizedQuery: string;
  prompts: SemanticQueryPrompt[];
  translationMode: SemanticTranslationMode;
  version: number;
}

interface QueryPlanOptions {
  translate?: (text: string) => Promise<string>;
}

interface NegativeExtraction {
  negativeTerms: string[];
  positiveText: string;
}

const pendingQueryPlans = new Map<string, Promise<SemanticQueryPlan>>();

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function detectLanguage(text: string): SemanticQueryLanguage {
  const hasChinese = CJK_RE.test(text);
  const hasLatin = LATIN_RE.test(text);
  if (hasChinese && hasLatin) {
    return "mixed";
  }
  return hasChinese ? "zh" : "en";
}

function cleanNegativeTerm(text: string): string {
  return normalizeWhitespace(
    text
      .replace(PHOTO_SUFFIX_RE, "")
      .replace(LEADING_NEGATIVE_AUX_RE, "")
      .replace(QUOTE_PUNCTUATION_RE, "")
  );
}

/**
 * Pull explicit negative visual concepts out before translation. SigLIP v1 is
 * much more reliable when a negative concept is scored separately than when
 * it is expected to understand Chinese negation in the raw query.
 */
export function extractNegativeClauses(query: string): NegativeExtraction {
  let positiveText = query;
  const negativeTerms: string[] = [];

  const addTerm = (term: string): void => {
    const cleaned = cleanNegativeTerm(term);
    if (cleaned && !negativeTerms.includes(cleaned)) {
      negativeTerms.push(cleaned);
    }
  };

  positiveText = positiveText.replace(/没有人|无人/g, () => {
    addTerm("人物");
    return " ";
  });

  positiveText = positiveText.replace(
    /(?:不要|不含|排除)\s*([^，。,.；;和与]{1,16})/g,
    (_match, term: string) => {
      addTerm(term);
      return " ";
    }
  );

  positiveText = positiveText.replace(
    /没有\s*([^的，。,.；;\s]{1,8})/g,
    (_match, term: string) => {
      addTerm(term);
      return " ";
    }
  );

  return {
    negativeTerms,
    positiveText: normalizeWhitespace(positiveText),
  };
}

function ensurePhotoPrompt(text: string): string {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return "";
  }
  return PHOTO_PROMPT_RE.test(normalized)
    ? normalized
    : `a photo of ${normalized}`;
}

function isEnglishPrompt(text: string): boolean {
  return Boolean(text.trim()) && !CJK_RE.test(text);
}

function appendProtectedLatinTerms(
  source: string,
  translation: string
): string {
  const translatedLower = translation.toLowerCase();
  const protectedTerms = source.match(LATIN_TERM_RE) ?? [];
  const missing = protectedTerms.filter(
    (term, index) =>
      protectedTerms.findIndex(
        (candidate) => candidate.toLowerCase() === term.toLowerCase()
      ) === index && !translatedLower.includes(term.toLowerCase())
  );
  return normalizeWhitespace([translation, ...missing].join(" "));
}

async function translateSafely(
  text: string,
  translate: (text: string) => Promise<string>
): Promise<string> {
  const translationInput = normalizeWhitespace(
    text.replace(QUOTED_CONTENT_RE, (_match, content: string) =>
      CJK_RE.test(content) ? " " : content
    )
  );
  if (!translationInput) {
    return "";
  }
  try {
    const translated = appendProtectedLatinTerms(
      text,
      normalizeWhitespace(await translate(translationInput))
    );
    return isEnglishPrompt(translated) ? translated : "";
  } catch {
    return "";
  }
}

function dedupePrompts(prompts: SemanticQueryPrompt[]): SemanticQueryPrompt[] {
  const seen = new Set<string>();
  return prompts.filter((prompt) => {
    const key = prompt.text.toLowerCase();
    if (!(isEnglishPrompt(prompt.text) && !seen.has(key))) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function dictionaryPrompts(query: string): {
  coverage: number;
  prompts: string[];
} {
  if (!CJK_RE.test(query)) {
    return { coverage: 1, prompts: [] };
  }
  const parsed = parseChineseQuery(query);
  return {
    coverage: getQueryCoverage(query, parsed),
    prompts: generateSearchPrompts(parsed).filter(isEnglishPrompt),
  };
}

export async function prepareSemanticQueryPlan(
  rawQuery: string,
  options: QueryPlanOptions = {}
): Promise<SemanticQueryPlan> {
  const original = normalizeWhitespace(rawQuery);
  const language = detectLanguage(original);
  const rewritten = rewriteQuery(original);
  const withoutCommands = normalizeWhitespace(
    (rewritten.cleanQuery || original).replace(SEARCH_COMMAND_RE, " ")
  );
  const { negativeTerms, positiveText } =
    extractNegativeClauses(withoutCommands);
  const normalizedQuery = normalizeWhitespace(positiveText);

  if (!normalizedQuery) {
    return {
      coverage: 0,
      language,
      negativePrompts: [],
      normalizedQuery,
      prompts: [],
      translationMode: "none",
      version: SEMANTIC_QUERY_PLAN_VERSION,
    };
  }

  if (language === "en") {
    return {
      coverage: 1,
      language,
      negativePrompts: negativeTerms
        .map(ensurePhotoPrompt)
        .filter(isEnglishPrompt),
      normalizedQuery,
      prompts: [
        {
          role: "primary",
          text: ensurePhotoPrompt(normalizedQuery),
          weight: 1,
        },
      ],
      translationMode: "none",
      version: SEMANTIC_QUERY_PLAN_VERSION,
    };
  }

  const dictionaryOnly =
    process.env.AI_ZH_QUERY_STRATEGY?.trim().toLowerCase() === "dictionary";
  const translate =
    options.translate ??
    (dictionaryOnly
      ? async (): Promise<string> => ""
      : translateChineseToEnglish);
  const dictionary = dictionaryPrompts(normalizedQuery);
  const [translated, ...translatedNegatives] = await Promise.all([
    translateSafely(normalizedQuery, translate),
    ...negativeTerms.map((term) => translateSafely(term, translate)),
  ]);

  const promptCandidates: SemanticQueryPrompt[] = [];
  if (translated) {
    promptCandidates.push({
      role: "primary",
      text: ensurePhotoPrompt(translated),
      weight: 1,
    });
  }
  if (dictionary.prompts[0]) {
    promptCandidates.push({
      role: "structured",
      text: dictionary.prompts[0],
      weight: 0.75,
    });
  }
  const focused = dictionary.prompts.find(
    (prompt) => prompt !== dictionary.prompts[0]
  );
  if (focused) {
    promptCandidates.push({
      role: "focused",
      text: focused,
      weight: 0.5,
    });
  }

  return {
    coverage: dictionary.coverage,
    language,
    negativePrompts: translatedNegatives
      .filter(Boolean)
      .map(ensurePhotoPrompt)
      .filter(isEnglishPrompt),
    normalizedQuery,
    prompts: dedupePrompts(promptCandidates).slice(0, 3),
    translationMode: translated ? "local" : "dictionary-fallback",
    version: SEMANTIC_QUERY_PLAN_VERSION,
  };
}

export function getSemanticQueryPlan(
  rawQuery: string
): Promise<SemanticQueryPlan> {
  const key = JSON.stringify({
    query: normalizeWhitespace(rawQuery),
    strategy:
      process.env.AI_ZH_QUERY_STRATEGY?.trim().toLowerCase() || "hybrid-zh-v2",
    version: SEMANTIC_QUERY_PLAN_VERSION,
  });
  const existing = pendingQueryPlans.get(key);
  if (existing) {
    return existing;
  }
  const task = prepareSemanticQueryPlan(rawQuery).finally(() => {
    if (pendingQueryPlans.get(key) === task) {
      pendingQueryPlans.delete(key);
    }
  });
  pendingQueryPlans.set(key, task);
  return task;
}

export function semanticQueryPlanCacheKey(
  plan: SemanticQueryPlan,
  modelKind: string,
  limit: number,
  translationModelVersion: string
): string {
  return JSON.stringify({
    limit,
    modelKind,
    negativePrompts: plan.negativePrompts,
    normalizedQuery: plan.normalizedQuery,
    prompts: plan.prompts,
    strategy: "hybrid-zh-v2",
    translationModelVersion,
    translationMode: plan.translationMode,
    version: plan.version,
  });
}
