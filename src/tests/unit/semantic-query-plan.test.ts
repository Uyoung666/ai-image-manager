import { afterEach, describe, expect, it, vi } from "vitest";
import {
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
  it("英文查询不经过翻译", async () => {
    const translate = vi.fn();
    const plan = await prepareSemanticQueryPlan("three cats at sunset", {
      translate,
    });

    expect(plan.language).toBe("en");
    expect(plan.translationMode).toBe("none");
    expect(plan.prompts).toEqual([
      {
        role: "primary",
        text: "a photo of three cats at sunset",
        weight: 1,
      },
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
    expect(plan.prompts[0]).toEqual({
      role: "primary",
      text: "a photo of an astronaut repairing a robot under neon lights",
      weight: 1,
    });
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
    expect(plan.negativePrompts).toEqual(["a photo of people"]);
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

  it("环境变量可回退到纯词典策略且绝不回退中文 embedding", async () => {
    process.env.AI_ZH_QUERY_STRATEGY = "dictionary";
    const plan = await prepareSemanticQueryPlan("可爱猫咪");

    expect(plan.translationMode).toBe("dictionary-fallback");
    expect(plan.prompts.length).toBeGreaterThan(0);
    expect(plan.prompts.every((prompt) => !CJK_RE.test(prompt.text))).toBe(
      true
    );
  });
});
