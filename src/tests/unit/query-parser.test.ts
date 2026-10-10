import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveEmbeddingFingerprint } from "@/services/ai/model-fingerprint";
import {
  generateSearchPrompts,
  getQueryCoverage,
  parseChineseQuery,
} from "@/services/ai/query-parser";
import {
  getSemanticQueryPlanFingerprint,
  prepareSemanticQueryPlan,
  SEMANTIC_QUERY_PLAN_VERSION,
  semanticQueryPlanCacheKey,
} from "@/services/ai/semantic-query-plan";
import { DictionaryManager } from "@/services/dictionary-manager";

const fixtureState = vi.hoisted(() => ({ root: "" }));
const dictionaryState = vi.hoisted(() => ({ getManager: vi.fn() }));
vi.mock("@/services/dictionary-manager", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/dictionary-manager")>()),
  getDictionaryManager: dictionaryState.getManager,
}));
vi.mock("@/utils/data-path", () => ({ getDataPath: () => fixtureState.root }));
vi.mock("@/utils/logger", () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn() }),
}));
const fixturesRoot = path.resolve(
  import.meta.dirname,
  "../../../reports/search-optimization/unit-query-parser"
);
const AMBIGUOUS_PROMPT_RE = /elderly|lightning|pillar/;
const SPURIOUS_PROMPT_RE = /elderly|lightning|sand\b/;
const COMPOUND_FRAGMENT_RE = /\bdoor\b|\bfield\b/;
const SHA_RE = /^[a-f0-9]{64}$/;
let manager: DictionaryManager;
beforeEach(() => {
  fs.mkdirSync(fixturesRoot, { recursive: true });
  fixtureState.root = fs.mkdtempSync(path.join(fixturesRoot, "parser-"));
  manager = new DictionaryManager();
  dictionaryState.getManager.mockReturnValue(manager);
});
afterEach(() => {
  vi.restoreAllMocks();
  const root = fs.realpathSync(fixturesRoot);
  const target = fs.realpathSync(fixtureState.root);
  if (
    !(
      target.startsWith(root + path.sep) &&
      path.basename(target).startsWith("parser-")
    )
  ) {
    throw new Error("Parser fixture cleanup escaped the isolated root");
  }
  fs.rmSync(target, { recursive: true, maxRetries: 3, retryDelay: 100 });
});

describe("bounded Chinese dictionary parsing", () => {
  it.each([
    "老电视",
    "流程图",
    "个人档案",
    "柱状图",
    "沙发",
    "风流",
    "沙袋",
    "车轮",
    "沙有发",
    "未知在电码",
    "沙过发",
    "沙是发",
    "也门",
    "和田",
    "红猫",
    "红包",
    "红人",
    "黑手",
    "黄流",
  ])("does not guess visual characters inside unknown compounds: %s", (query) => {
    const parsed = parseChineseQuery(query);
    expect(generateSearchPrompts(parsed)).toEqual([]);
    expect(parsed.unknown).toEqual([...query]);
    expect(getQueryCoverage(query, parsed)).toBe(0);
  });

  it.each([
    "猫在也门",
    "夜晚的也门",
    "相机在也门",
    "猫在和田",
    "夜晚的和田",
    "相机在和田",
  ])("does not mistake stopwords within sentence compounds for syntax: %s", (query) => {
    const parsed = parseChineseQuery(query);
    expect(generateSearchPrompts(parsed).join(" ")).not.toMatch(
      COMPOUND_FRAGMENT_RE
    );
    expect(parsed.unknown.length).toBeGreaterThan(0);
  });

  it.each([
    "老相机",
    "相机老",
    "电相机",
    "溪流柱",
    "包相机",
  ])("does not isolate an ambiguous fallback beside a known word: %s", (query) => {
    const prompts = generateSearchPrompts(parseChineseQuery(query)).join(" ");
    expect(prompts).not.toMatch(AMBIGUOUS_PROMPT_RE);
    if (query === "包相机") {
      expect(parseChineseQuery(query).subject).toEqual(["相机"]);
      expect(parseChineseQuery(query).unknown).toEqual(["包"]);
    }
  });

  it("preserves independent characters, known color words and explicit function-word boundaries", () => {
    const standalone = parseChineseQuery("猫，沙；柱，红 蓝");
    expect(standalone.subject).toEqual(expect.arrayContaining(["猫", "柱"]));
    expect(standalone.scene).toContain("沙");
    expect(standalone.color).toEqual(["红", "蓝"]);
    expect(standalone.unknown).toEqual([]);
    const colored = parseChineseQuery("红色猫和蓝色花");
    expect(colored.subject).toEqual(expect.arrayContaining(["猫", "花"]));
    expect(colored.color).toEqual(expect.arrayContaining(["红色", "蓝色"]));
    expect(colored.unknown).toEqual([]);
    const known = parseChineseQuery("老人和闪电在溪流");
    expect(known.subject).toContain("老人");
    expect(known.weather).toContain("闪电");
    expect(known.scene).toContain("溪流");
    expect(parseChineseQuery("猫在草地").subject).toEqual(["猫"]);
    expect(parseChineseQuery("猫的相机").subject).toEqual(
      expect.arrayContaining(["猫", "相机"])
    );
    expect(parseChineseQuery("猫咪和狗").subject).toEqual(
      expect.arrayContaining(["猫咪", "狗"])
    );
    expect(parseChineseQuery("红 猫").subject).toEqual(["猫"]);
    expect(parseChineseQuery("红 猫").color).toEqual(["红"]);
  });

  it("retains whitespace, Latin and punctuation boundaries without losing unknown occurrences", () => {
    const parsed = parseChineseQuery("沙滩 沙发，猫 Tesla 红");
    expect(parsed.scene).toEqual(["沙滩"]);
    expect(parsed.subject).toEqual(["猫"]);
    expect(parsed.color).toEqual(["红"]);
    expect(parsed.unknown).toEqual(["沙", "发"]);
    expect(getQueryCoverage("沙滩 沙发，猫 Tesla 红", parsed)).toBeCloseTo(
      4 / 6
    );
    expect(generateSearchPrompts(parseChineseQuery("沙发和未知电码"))).toEqual(
      []
    );
  });

  it("uses custom words and overrides while disabled entries cannot return through fallback", async () => {
    await manager.addCustomEntry("流程图", {
      en: "flowchart diagram",
      category: "object",
    });
    await manager.addCustomEntry("钺", { en: "axe", category: "object" });
    await manager.overrideBuiltinEntry("猫", {
      en: "custom feline",
      category: "subject",
    });
    let prompts = generateSearchPrompts(parseChineseQuery("流程图 猫 钺"));
    expect(prompts.join(" ")).toContain("flowchart diagram custom feline axe");
    await manager.disableBuiltinEntry("猫");
    await manager.addCustomEntry("猫", {
      en: "restored cat",
      category: "subject",
    });
    await manager.disableBuiltinEntry("流程图");
    await manager.disableBuiltinEntry("红裙");
    expect(manager.getMergedDictionary().猫).toBeUndefined();
    expect(manager.getMergedDictionary().流程图).toBeUndefined();
    prompts = generateSearchPrompts(parseChineseQuery("流程图 猫 红裙"));
    expect(prompts).toEqual([]);
    await manager.enableBuiltinEntry("猫");
    expect(generateSearchPrompts(parseChineseQuery("猫")).join(" ")).toContain(
      "custom feline"
    );
  });

  it("keeps the full translated primary and separates independent subjects from repeated terms", async () => {
    const translate = vi.fn(async () => "an old television beside a red sofa");
    const plan = await prepareSemanticQueryPlan("老电视旁边的红色沙发", {
      translate,
    });
    expect(translate).toHaveBeenCalledWith("老电视旁边的红色沙发");
    expect(plan.prompts[0]).toMatchObject({
      role: "primary",
      evidenceGroup: "whole-query",
      text: "This is a photo of an old television beside a red sofa.",
    });
    expect(
      plan.prompts.every(({ text }) => !SPURIOUS_PROMPT_RE.test(text))
    ).toBe(true);
    const different = await prepareSemanticQueryPlan("猫和狗", {
      translate: async () => "a cat and a dog",
    });
    const repeated = await prepareSemanticQueryPlan("猫和猫", {
      translate: async () => "two cats",
    });
    expect(different.intent).toBe("composed");
    expect(repeated.intent).toBe("object");
    const aliases = await prepareSemanticQueryPlan("猫和猫咪", {
      translate: async () => "cats",
    });
    expect(aliases.intent).toBe("object");
    await manager.addCustomEntry("猫咪", {
      en: "a distinct custom object",
      category: "subject",
    });
    const distinctCustom = await prepareSemanticQueryPlan("猫和猫咪", {
      translate: async () => "cats and a distinct custom object",
    });
    expect(distinctCustom.intent).toBe("composed");
  });

  it("changes query cache identity through plan version without changing the image fingerprint", async () => {
    const before = getActiveEmbeddingFingerprint();
    expect(SEMANTIC_QUERY_PLAN_VERSION).toBe(8);
    const plan = await prepareSemanticQueryPlan("cat");
    expect(
      semanticQueryPlanCacheKey(plan, before, 100, "translation")
    ).not.toBe(
      semanticQueryPlanCacheKey(
        { ...plan, version: 7 },
        before,
        100,
        "translation"
      )
    );
    expect(getSemanticQueryPlanFingerprint("translation")).toMatch(SHA_RE);
    expect(getActiveEmbeddingFingerprint()).toBe(before);
  });
});
