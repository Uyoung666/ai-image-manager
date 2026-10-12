import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalizeSemanticPrompt,
  extractNegativeClauses,
  prepareSemanticQueryPlan,
  semanticQueryPlanCacheKey,
} from "@/services/ai/semantic-query-plan";

const CJK_RE = /[一-鿿]/;
const TIME_PROMPT_RE = /last year|summer/i;
const originalStrategy = process.env.AI_ZH_QUERY_STRATEGY;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalStrategy === undefined) {
    delete process.env.AI_ZH_QUERY_STRATEGY;
  } else {
    process.env.AI_ZH_QUERY_STRATEGY = originalStrategy;
  }
});

describe("SemanticQueryPlan", () => {
  it("carries explicit object evidence without changing whole-query translation or prompts", async () => {
    const translate = vi.fn(async () => "a gold watch and jewelry");
    const plan = await prepareSemanticQueryPlan("金色手表和珠宝", {
      translate,
    });
    const english = await prepareSemanticQueryPlan("a gold watch and jewelry");
    expect(plan.concreteObjectQuery).toBe(true);
    expect(english.concreteObjectQuery).not.toBe(true);
    expect(plan.prompts[0].text).toBe(english.prompts[0].text);
    expect(translate).toHaveBeenCalledWith("金色手表和珠宝");
    const person = await prepareSemanticQueryPlan("扶着拐杖的老人", {
      translate: async () => "an elderly person with a walking stick",
    });
    expect(person.concreteObjectQuery).toBe(false);
  });

  it.each([
    ["嵌入式灯具", "a ceiling light", "object"],
    ["雾中的城池", "foggy city", "scene"],
    ["猫在瓷砖边", "a cat near patterned tiles", "composed"],
    ["红色镶嵌符号", "a red geometric emblem", "composed"],
    ["猫与UncataloguedBrand", "a cat near UncataloguedBrand", "composed"],
  ] as const)("词典未完整解析时按完整主句判断意图：%s", async (query, translated, intent) => {
    const translate = vi.fn(async () => translated);
    const chinese = await prepareSemanticQueryPlan(query, { translate });
    const english = await prepareSemanticQueryPlan(translated);
    expect(chinese.intent).toBe(intent);
    expect(chinese.intent).toBe(english.intent);
    expect(chinese.prompts[0]).toMatchObject({
      role: "primary",
      text: english.prompts[0].text,
    });
    expect(translate).toHaveBeenCalledWith(query);
  });

  it("完整翻译失败时不凭未知复合词猜意图", async () => {
    const plan = await prepareSemanticQueryPlan("嵌入式灯具", {
      translate: async () => "",
    });
    expect(plan.intent).toBe("unknown");
    expect(plan.translationMode).toBe("dictionary-fallback");
    expect(plan.prompts).toEqual([]);
  });

  it.each([
    "无人机在海边",
    "无人驾驶汽车在城市",
    "无人区里的雪山",
    "没有人驾驶的无人机",
    "海边，不要在沙滩上玩耍的狗",
  ])("不截断无法可靠拆分的实体或从句：%s", (query) => {
    expect(extractNegativeClauses(query)).toEqual({
      negativeTerms: [],
      positiveText: query,
    });
  });

  it.each([
    "没有人的海边",
    "没有人物的海边",
    "无人的海边",
  ])("完整提取缺人条件并保留场景：%s", (query) => {
    expect(extractNegativeClauses(query)).toEqual({
      negativeTerms: ["人物"],
      positiveText: "海边",
    });
  });

  it.each([
    "海边，不要狗和猫",
    "海边，不含狗与猫",
    "没有狗和猫的海边",
  ])("将全部并列否定概念交给负向评分：%s", (query) => {
    expect(extractNegativeClauses(query)).toEqual({
      negativeTerms: ["狗", "猫"],
      positiveText: "海边",
    });
  });

  it("引号内名称不按否定命令解析", () => {
    expect(extractNegativeClauses('"无人"在海边，不要狗和猫')).toEqual({
      negativeTerms: ["狗", "猫"],
      positiveText: '"无人"在海边',
    });
  });

  it("保留被排除对象的完整词，不将有轨电车截成轨电车", () => {
    expect(extractNegativeClauses("海边，不要有轨电车")).toEqual({
      negativeTerms: ["有轨电车"],
      positiveText: "海边",
    });
  });

  it("并列否定分别翻译，正向模型输入不包含被排除的对象", async () => {
    const translations: Record<string, string> = {
      海边: "beach",
      狗: "dog",
      猫: "cat",
    };
    const translate = vi.fn(async (text: string) => translations[text]);
    const plan = await prepareSemanticQueryPlan("海边，不要狗和猫", {
      translate,
    });
    expect(plan.visualDescription).toBe("海边");
    expect(plan.prompts[0].text).toBe("This is a photo of beach.");
    expect(plan.negativePrompts).toEqual([
      "This is a photo of dog.",
      "This is a photo of cat.",
    ]);
    expect(translate).toHaveBeenCalledWith("狗");
    expect(translate).toHaveBeenCalledWith("猫");
  });

  it("英文查询不经过翻译", async () => {
    const translate = vi.fn();
    const plan = await prepareSemanticQueryPlan("three cats at sunset", {
      translate,
    });

    expect(plan.language).toBe("en");
    expect(plan.translationMode).toBe("none");
    expect(plan.prompts).toEqual([
      expect.objectContaining({
        role: "primary",
        text: "This is a photo of three cats at sunset.",
        weight: 1,
      }),
    ]);
    expect(translate).not.toHaveBeenCalled();
  });

  it("未知中文完整句子优先使用本地整句翻译", async () => {
    const plan = await prepareSemanticQueryPlan("宇航员在霓虹灯下修理机器人", {
      translate: vi
        .fn()
        .mockResolvedValue("an astronaut repairing a robot under neon lights"),
    });

    expect(plan.language).toBe("zh");
    expect(plan.translationMode).toBe("local");
    expect(plan.prompts[0]).toEqual(
      expect.objectContaining({
        role: "primary",
        text: "This is a photo of an astronaut repairing a robot under neon lights.",
        weight: 1,
      })
    );
  });

  it("中英混合查询保留英文、数字和数量语义", async () => {
    const translate = vi
      .fn()
      .mockResolvedValue("three cats next to a red Tesla Model 3");
    const plan = await prepareSemanticQueryPlan(
      "三只猫在红色 Tesla Model 3 旁边",
      { translate }
    );

    expect(plan.language).toBe("mixed");
    expect(plan.prompts[0].text).toContain("three cats");
    expect(plan.prompts[0].text).toContain("Tesla");
    expect(plan.prompts[0].text).toContain("Model");
    expect(plan.prompts[0].text).toContain("3");
  });

  it("中文引号内容留给精确搜索，不让翻译破坏人物名", async () => {
    const translate = vi.fn().mockResolvedValue("on the beach");
    const plan = await prepareSemanticQueryPlan("“小美”在海滩", {
      translate,
    });

    expect(translate).toHaveBeenCalledWith("在海滩");
    expect(plan.normalizedQuery).toContain("小美");
    expect(plan.prompts.every((prompt) => !prompt.text.includes("小美"))).toBe(
      true
    );
  });

  it("时间表达式不进入视觉 Prompt", async () => {
    const translate = vi.fn().mockResolvedValue("cats");
    const plan = await prepareSemanticQueryPlan("去年夏天拍的猫", {
      translate,
    });

    expect(translate).toHaveBeenCalledWith("猫");
    expect(plan.normalizedQuery).toBe("猫");
    expect(
      plan.prompts.every((prompt) => !TIME_PROMPT_RE.test(prompt.text))
    ).toBe(true);
  });

  it("否定概念与正向召回分离", async () => {
    const translate = vi.fn(async (text: string) =>
      text === "人物" ? "people" : "snow mountain"
    );
    const plan = await prepareSemanticQueryPlan("没有人的雪山", {
      translate,
    });

    expect(extractNegativeClauses("没有人的雪山").negativeTerms).toContain(
      "人物"
    );
    expect(plan.prompts[0].text).toContain("snow mountain");
    expect(plan.negativePrompts).toEqual(["This is a photo of people."]);
  });

  it("翻译失败时使用词典，零覆盖时跳过语义分支", async () => {
    const dictionaryPlan = await prepareSemanticQueryPlan("猫在海滩", {
      translate: vi.fn().mockRejectedValue(new Error("worker crashed")),
    });
    const unknownPlan = await prepareSemanticQueryPlan("魑魅魍魉", {
      translate: vi.fn().mockResolvedValue(""),
    });

    expect(dictionaryPlan.translationMode).toBe("dictionary-fallback");
    expect(dictionaryPlan.prompts.length).toBeGreaterThan(0);
    expect(unknownPlan.translationMode).toBe("dictionary-fallback");
    expect(unknownPlan.coverage).toBe(0);
    expect(unknownPlan.prompts).toEqual([]);
  });

  it("SigLIP v1 的全部查询 Prompt 强制不含 CJK", async () => {
    const cases = [
      ["可爱猫咪", "cute kitten"],
      ["红色 Tesla 在夜晚", "red Tesla at night"],
      ["三只狗", "three dogs"],
      ["不要汽车的城市", "city"],
      ["赛博朋克风格的人像", "cyberpunk portrait"],
    ] as const;

    for (const [query, translation] of cases) {
      const plan = await prepareSemanticQueryPlan(query, {
        translate: vi.fn().mockResolvedValue(translation),
      });
      expect(
        [
          ...plan.prompts.map((prompt) => prompt.text),
          ...plan.negativePrompts,
        ].some((prompt) => CJK_RE.test(prompt))
      ).toBe(false);
      expect(
        plan.prompts.every((prompt) => prompt.text.startsWith("This is "))
      ).toBe(true);
    }
  });

  it("缓存键包含负向 Prompt 和计划版本", async () => {
    const positive = await prepareSemanticQueryPlan("snow mountain");
    const negative = {
      ...positive,
      negativePrompts: ["a photo of people"],
    };

    expect(
      semanticQueryPlanCacheKey(positive, "siglip", 50, "opus-v1")
    ).not.toBe(semanticQueryPlanCacheKey(negative, "siglip", 50, "opus-v1"));
  });

  it("缓存键包含灵敏度预设", async () => {
    const plan = await prepareSemanticQueryPlan("snow mountain");

    expect(
      semanticQueryPlanCacheKey(plan, "siglip", 50, "opus-v1", "standard")
    ).not.toBe(
      semanticQueryPlanCacheKey(plan, "siglip", 50, "opus-v1", "relaxed")
    );
  });

  it("缓存键区分阈值分类，即使主句和提示词相同", async () => {
    const plan = await prepareSemanticQueryPlan("snow mountain");
    const key = semanticQueryPlanCacheKey(plan, "siglip", 50, "opus-v1");

    expect(key).not.toBe(
      semanticQueryPlanCacheKey(
        { ...plan, concreteObjectQuery: true },
        "siglip",
        50,
        "opus-v1"
      )
    );
    expect(key).not.toBe(
      semanticQueryPlanCacheKey(
        { ...plan, intent: "object" },
        "siglip",
        50,
        "opus-v1"
      )
    );
  });

  it("环境变量可回退到纯词典策略且绝不回退中文 embedding", async () => {
    process.env.AI_ZH_QUERY_STRATEGY = "dictionary";
    const plan = await prepareSemanticQueryPlan("可爱猫咪");

    expect(plan.translationMode).toBe("dictionary-fallback");
    expect(plan.prompts.length).toBeGreaterThan(0);
    expect(plan.prompts.every((prompt) => !CJK_RE.test(prompt.text))).toBe(
      true
    );
  });

  it("Bicycle and bicycle form one evidence group", async () => {
    const plan = await prepareSemanticQueryPlan("\u81ea\u884c\u8f66", {
      translate: vi.fn().mockResolvedValue("Bicycle"),
    });

    expect(canonicalizeSemanticPrompt("This is a photo of Bicycle.")).toBe(
      canonicalizeSemanticPrompt("a photo of a bicycle")
    );
    expect(plan.rawPromptCount).toBeGreaterThanOrEqual(2);
    expect(
      new Set(plan.prompts.map(({ evidenceGroup }) => evidenceGroup))
    ).toEqual(new Set(["whole-query"]));
    expect(plan.prompts[0].canonicalKey).toBe("bicycle");
    expect(plan.intent).toBe("object");
  });
});
