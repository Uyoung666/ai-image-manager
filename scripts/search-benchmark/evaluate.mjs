import { summarizeDistribution } from "../siglip-v1-baseline/statistics.mjs";

export function measuredDistribution(values) {
  const finite = values.filter(
    (value) => typeof value === "number" && Number.isFinite(value)
  );
  if (!finite.length) {
    return { count: 0, p50: null, p95: null, max: null };
  }
  return summarizeDistribution(finite);
}

const mean = (values) =>
  values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;

/** Unjudged results are reported separately and never silently counted as false positives. */
export function evaluateSearchRun(definition, run) {
  const rows = definition.queries.map((query) => {
    const actual = run.queries.find((row) => row.id === query.id);
    if (!actual) {
      throw new Error(`Missing query ${query.id}`);
    }
    const relevant = new Set(query.relevantSampleIds);
    const unknown = new Set(query.unjudgedSampleIds ?? []);
    const hard = new Set(query.hardNegativeSampleIds ?? []);
    const unique = [...new Set(actual.results)];
    const judged = unique.filter((id) => !unknown.has(id));
    const first = judged.findIndex((id) => relevant.has(id));
    const dcg = judged
      .slice(0, 10)
      .reduce(
        (sum, id, index) =>
          sum + (relevant.has(id) ? 1 / Math.log2(index + 2) : 0),
        0
      );
    const ideal = Array.from(
      { length: Math.min(10, relevant.size) },
      (_, index) => 1 / Math.log2(index + 2)
    ).reduce((sum, value) => sum + value, 0);
    const reciprocalRank = first < 0 ? 0 : 1 / (first + 1);
    return {
      id: query.id,
      split: query.split,
      ndcgAt10: relevant.size ? dcg / ideal : null,
      mrr: relevant.size ? reciprocalRank : null,
      recallAt50: relevant.size
        ? judged.slice(0, 50).filter((id) => relevant.has(id)).length /
          relevant.size
        : null,
      hardNegativeAt10: hard.size
        ? Number(unique.slice(0, 10).some((id) => hard.has(id)))
        : null,
      emptyFalsePositive:
        query.expectEmpty && !unknown.size ? Number(unique.length > 0) : null,
      judgmentCoverage: (actual.scopeSize - unknown.size) / actual.scopeSize,
      returnedJudgmentCoverage: unique.length
        ? judged.length / unique.length
        : 1,
      unjudgedReturned: unique.filter((id) => unknown.has(id)),
      completion: actual.completion ?? "unmeasured",
    };
  });
  const metric = (name) =>
    mean(rows.map((row) => row[name]).filter((value) => value !== null));
  return {
    schemaVersion: 1,
    metrics: {
      ndcgAt10: metric("ndcgAt10"),
      mrr: metric("mrr"),
      recallAt50: metric("recallAt50"),
      hardNegativeRateAt10: metric("hardNegativeAt10"),
      emptyFalsePositiveRate: metric("emptyFalsePositive"),
      judgmentCoverage: metric("judgmentCoverage"),
      returnedJudgmentCoverage: metric("returnedJudgmentCoverage"),
    },
    perQuery: rows,
  };
}
