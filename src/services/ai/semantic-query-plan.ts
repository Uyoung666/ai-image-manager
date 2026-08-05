import { rewriteQuery } from "@/services/query-rewrite";
import {
  getActiveEmbeddingModel,
  getSemanticPolicyVersion,
} from "./model-config";
import {
  generateSearchPrompts,
  getQueryCoverage,
  parseChineseQuery,
} from "./query-parser";
import { translateChineseToEnglish } from "./translation-worker-client";

export const SEMANTIC_QUERY_PLAN_VERSION = 4;

const CJK_RE = /[一-鿿]/;
const LATIN_RE = /[A-Za-z]/;
const WHITESPACE_RE = /\s+/g;
const PHOTO_NOUN_RE = /\b(?:photo|photograph|picture|image)\b/i;
const SIGLIP_PROMPT_PREFIX_RE = /^this\s+is\b/i;
const TRAILING_PERIOD_RE = /[.]+$/;
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
export type SemanticEvidenceGroup = "whole-query" | "subject" | "scene";
export type SemanticQueryIntent = "object" | "scene" | "composed" | "unknown";
export type SemanticQueryLanguage = "en" | "zh" | "mixed";
export type SemanticTranslationMode = "none" | "local" | "dictionary-fallback";

const CANONICAL_TRAILING_PUNCTUATION_RE = /[.!?,;:]+$/g;
const CANONICAL_PHOTO_WRAPPER_RE =
  /^(?:this\s+is\s+)?(?:a|an|the)?\s*(?:photo|photograph|picture|image)\s+of\s+/;
const CANONICAL_LEADING_ARTICLE_RE = /^(?:a|an|the)\s+/;
const SCENE_FOCUSED_PROMPT_RE = /\bscenic\b|\bscene\b/i;

export interface SemanticQueryPrompt {
  canonicalKey: string;
  evidenceGroup: SemanticEvidenceGroup;
  role: SemanticPromptRole;
  text: string;
  weight: number;
}

export interface SemanticQueryPlan {
  coverage: number;
  intent: SemanticQueryIntent;
  language: SemanticQueryLanguage;
  negativePrompts: string[];
  normalizedQuery: string;
  prompts: SemanticQueryPrompt[];
  rawPromptCount: number;
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

const ENGLISH_SCENE_TERMS = new Set([
  "beach",
  "city",
  "forest",
  "fog",
  "foggy",
  "landscape",
  "mountain",
  "night",
  "ocean",
  "rain",
  "rainy",
  "sea",
  "sky",
  "snow",
  "street",
  "sunrise",
  "sunset",
]);

function normalizeWhitespace(text: string): string {
  return text.replace(WHITESPACE_RE, " ").trim();
}

export function canonicalizeSemanticPrompt(text: string): string {
  let canonical = normalizeWhitespace(text)
    .toLocaleLowerCase()
    .replace(CANONICAL_TRAILING_PUNCTUATION_RE, "")
    .replace(CANONICAL_PHOTO_WRAPPER_RE, "")
    .replace(CANONICAL_LEADING_ARTICLE_RE, "");
  canonical = canonical.replace(WHITESPACE_RE, " ").trim();
  return canonical;
}

function classifyParsedIntent(
  parsed: ReturnType<typeof parseChineseQuery>
): SemanticQueryIntent {
  const subjectCount = parsed.subject.length;
  const sceneCount =
    parsed.scene.length +
    parsed.time.length +
    parsed.weather.length +
    parsed.style.length;
  const modifierCount =
    parsed.activity.length + parsed.color.length + sceneCount;
  if (parsed.unknown.length > 0 && subjectCount + modifierCount === 0) {
    return "unknown";
  }
  if (subjectCount > 0 && modifierCount === 0) {
    return "object";
  }
  if (subjectCount === 0 && sceneCount > 0 && parsed.activity.length === 0) {
    return "scene";
  }
  if (subjectCount + modifierCount > 1) {
    return "composed";
  }
  return "unknown";
}

function classifyEnglishIntent(query: string): SemanticQueryIntent {
  const words = canonicalizeSemanticPrompt(query)
    .split(WHITESPACE_RE)
    .filter(Boolean);
  if (words.length === 0) {
    return "unknown";
  }
  if (words.every((word) => ENGLISH_SCENE_TERMS.has(word))) {
    return "scene";
  }
  return words.length <= 2 ? "object" : "composed";
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
  const normalized = normalizeWhitespace(text).replace(TRAILING_PERIOD_RE, "");
  if (!normalized) {
    return "";
  }
  if (getActiveEmbeddingModel().kind === "siglip") {
    if (SIGLIP_PROMPT_PREFIX_RE.test(normalized)) {
      return `${normalized}.`;
    }
    if (PHOTO_NOUN_RE.test(normalized)) {
      return `This is ${normalized}.`;
    }
    return `This is a photo of ${normalized}.`;
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
  const deduped = new Map<string, SemanticQueryPrompt>();
  for (const prompt of prompts) {
    if (!isEnglishPrompt(prompt.text)) {
      continue;
    }
    const canonicalKey = canonicalizeSemanticPrompt(prompt.text);
    if (!canonicalKey) {
      continue;
    }
    const existing = deduped.get(canonicalKey);
    if (!existing || prompt.weight > existing.weight) {
      deduped.set(canonicalKey, { ...prompt, canonicalKey });
    }
  }
  return [...deduped.values()];
}

function dictionaryPrompts(query: string): {
  coverage: number;
  intent: SemanticQueryIntent;
  prompts: string[];
} {
  if (!CJK_RE.test(query)) {
    return { coverage: 1, intent: classifyEnglishIntent(query), prompts: [] };
  }
  const parsed = parseChineseQuery(query);
  return {
    coverage: getQueryCoverage(query, parsed),
    intent: classifyParsedIntent(parsed),
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
      intent: "unknown",
      language,
      negativePrompts: [],
      normalizedQuery,
      rawPromptCount: 0,
      prompts: [],
      translationMode: "none",
      version: SEMANTIC_QUERY_PLAN_VERSION,
    };
  }

  if (language === "en") {
    return {
      coverage: 1,
      intent: classifyEnglishIntent(normalizedQuery),
      language,
      negativePrompts: negativeTerms
        .map(ensurePhotoPrompt)
        .filter(isEnglishPrompt),
      normalizedQuery,
      rawPromptCount: 1,
      prompts: [
        {
          canonicalKey: canonicalizeSemanticPrompt(normalizedQuery),
          evidenceGroup: "whole-query",
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
      canonicalKey: canonicalizeSemanticPrompt(translated),
      evidenceGroup: "whole-query",
      role: "primary",
      text: ensurePhotoPrompt(translated),
      weight: 1,
    });
  }
  if (dictionary.prompts[0]) {
    promptCandidates.push({
      canonicalKey: canonicalizeSemanticPrompt(dictionary.prompts[0]),
      evidenceGroup: "whole-query",
      role: "structured",
      text: ensurePhotoPrompt(dictionary.prompts[0]),
      weight: 0.75,
    });
  }
  const focused = dictionary.prompts.find(
    (prompt) => prompt !== dictionary.prompts[0]
  );
  if (focused) {
    promptCandidates.push({
      canonicalKey: canonicalizeSemanticPrompt(focused),
      evidenceGroup: SCENE_FOCUSED_PROMPT_RE.test(focused)
        ? "scene"
        : "subject",
      role: "focused",
      text: ensurePhotoPrompt(focused),
      weight: 0.5,
    });
  }

  return {
    coverage: dictionary.coverage,
    intent: dictionary.intent,
    language,
    negativePrompts: translatedNegatives
      .filter(Boolean)
      .map(ensurePhotoPrompt)
      .filter(isEnglishPrompt),
    normalizedQuery,
    rawPromptCount: promptCandidates.length,
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
  translationModelVersion: string,
  sensitivity = "standard"
): string {
  return JSON.stringify({
    limit,
    modelKind,
    negativePrompts: plan.negativePrompts,
    normalizedQuery: plan.normalizedQuery,
    prompts: plan.prompts,
    policy: getSemanticPolicyVersion(),
    sensitivity,
    strategy: "hybrid-zh-v2",
    translationModelVersion,
    translationMode: plan.translationMode,
    version: plan.version,
  });
}
