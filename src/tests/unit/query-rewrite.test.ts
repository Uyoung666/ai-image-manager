import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rewriteQuery } from "@/services/query-rewrite";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 8, 12));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("quoted names in query rewriting", () => {
  it.each([
    '"昨天.jpg"',
    "“春天”",
    '"去年夏天.jpg"',
    '"帮我找照片"',
    "“去年  夏天的照片”",
  ])("preserves the exact name %s without adding a date filter", (query) => {
    expect(rewriteQuery(query)).toMatchObject({
      cleanQuery: query,
      originalQuery: query,
      removedTerms: [],
      timeFilter: undefined,
      timeMatchedText: undefined,
    });
  });

  it("preserves a quoted filename beside a visual description", () => {
    const query = '"去年夏天.jpg" on a mountain';
    expect(rewriteQuery(query)).toMatchObject({
      cleanQuery: query,
      timeFilter: undefined,
      timeMatchedText: undefined,
    });
  });

  it.each([
    "2024年3月 “春天”",
    "“春天” 2024年3月",
    "帮我找2024年3月拍的“春天”照片",
  ])("extracts the external date while preserving the name: %s", (query) => {
    expect(rewriteQuery(query)).toMatchObject({
      cleanQuery: "“春天”",
      timeMatchedText: "2024年3月",
      timeFilter: {
        from: new Date(2024, 2, 1).getTime(),
        to: new Date(2024, 2, 31, 23, 59, 59, 999).getTime(),
      },
    });
  });

  it("only parses the date outside multiple quoted names", () => {
    expect(rewriteQuery('昨天 "春天.jpg" “去年  夏天”')).toMatchObject({
      cleanQuery: '"春天.jpg" “去年  夏天”',
      timeMatchedText: "昨天",
      timeFilter: {
        from: new Date(2026, 9, 7).getTime(),
        to: new Date(2026, 9, 7, 23, 59, 59, 999).getTime(),
      },
    });
  });

  it.each([
    ["2024年3月", 1, 31],
    ["2024年3月15日", 15, 15],
    ["2024-03-15", 15, 15],
  ])("removes the complete external date %s", (date, firstDay, lastDay) => {
    expect(rewriteQuery(`${date}“昨天.jpg”`)).toMatchObject({
      cleanQuery: "“昨天.jpg”",
      timeMatchedText: date,
      timeFilter: {
        from: new Date(2024, 2, firstDay).getTime(),
        to: new Date(2024, 2, lastDay, 23, 59, 59, 999).getTime(),
      },
    });
  });

  it("restores names without colliding with existing private-use text", () => {
    const query = "\uE0000\uE001 “春天”";
    expect(rewriteQuery(query)).toMatchObject({
      cleanQuery: query,
      timeFilter: undefined,
    });
  });

  it.each([
    ["去年夏天拍的猫", "猫", "去年夏天"],
    ["过去2周拍的猫", "猫", "过去2周"],
    ["帮我找无人驾驶汽车在城市的照片", "无人驾驶汽车在城市", undefined],
    ["没有人物的海边", "没有人物的海边", undefined],
    ["今天", "", "今天"],
  ])("keeps existing unquoted rewriting for %s", (query, cleanQuery, matched) => {
    expect(rewriteQuery(query)).toMatchObject({
      cleanQuery,
      timeMatchedText: matched,
    });
  });
});
