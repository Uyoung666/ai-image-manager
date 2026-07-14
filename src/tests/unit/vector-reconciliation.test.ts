import { describe, expect, it } from "vitest";
import { planVectorReconciliation } from "@/services/ai/vector-reconciliation";

describe("vector reconciliation", () => {
  it("识别已从 SQLite 删除的文件夹照片向量", () => {
    const plan = planVectorReconciliation([1, 2, 3, 9, 10], [1, 2, 3]);

    expect(plan.orphanIds).toEqual([9, 10]);
    expect(plan.duplicateIds).toEqual([]);
  });

  it("识别软删除照片和有效照片的重复向量", () => {
    const plan = planVectorReconciliation(
      [1, 1, 2, 3, 3, 3, 4],
      [1, 2, 3, 4],
      [4]
    );

    expect(plan.orphanIds).toEqual([4]);
    expect(plan.duplicateIds).toEqual([1, 3]);
  });

  it("忽略无法用于 LanceDB 过滤的非法 ID", () => {
    const plan = planVectorReconciliation([0, -1, Number.NaN, 1], [1]);

    expect(plan).toEqual({ orphanIds: [], duplicateIds: [] });
  });
});
