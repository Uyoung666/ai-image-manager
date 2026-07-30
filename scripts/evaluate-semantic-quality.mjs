/**
 * Read-only semantic-search quality evaluator.
 *
 * Usage:
 *   node scripts/evaluate-semantic-quality.mjs <manifest.json> <run.json>
 *
 * The manifest and run files identify photos by stable contentHash values.
 * This script never opens or changes the application database or vector index.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function mean(values) {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function percentile(values, percentileValue) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)
  ];
}

function precisionAt(results, relevant, cutoff) {
  const page = results.slice(0, cutoff);
  return ratio(
    page.filter((contentHash) => relevant.has(contentHash)).length,
    Math.min(cutoff, page.length)
  );
}

function recallAt(results, relevant, cutoff) {
  return ratio(
    results.slice(0, cutoff).filter((contentHash) => relevant.has(contentHash))
      .length,
    relevant.size
  );
}

function ndcgAt(results, relevant, cutoff) {
  let dcg = 0;
  for (let index = 0; index < Math.min(cutoff, results.length); index += 1) {
    if (relevant.has(results[index])) {
      dcg += 1 / Math.log2(index + 2);
    }
  }
  let ideal = 0;
  for (let index = 0; index < Math.min(cutoff, relevant.size); index += 1) {
    ideal += 1 / Math.log2(index + 2);
  }
  return ratio(dcg, ideal);
}

export function evaluateSemanticRun(manifest, run) {
  const runById = new Map(run.queries.map((query) => [query.id, query]));
  const perQuery = manifest.queries.map((query) => {
    const actual = runById.get(query.id);
    if (!actual) {
      throw new Error(`Missing benchmark run for query id: ${query.id}`);
    }
    const relevant = new Set(query.relevantContentHashes);
    const results = actual.results.map((result) =>
      typeof result === "string" ? result : result.contentHash
    );
    const falsePositives = results.filter(
      (contentHash) => !relevant.has(contentHash)
    );
    const errorCategories = {};
    for (const contentHash of falsePositives) {
      const category =
        manifest.errorCategoryByContentHash?.[contentHash] ?? "unclassified";
      errorCategories[category] = (errorCategories[category] ?? 0) + 1;
    }
    return {
      id: query.id,
      category: query.category,
      intent: query.intent,
      query: query.query,
      precisionAt20: precisionAt(results, relevant, 20),
      precisionAt50: precisionAt(results, relevant, 50),
      recallAt50: recallAt(results, relevant, 50),
      recallAt200: recallAt(results, relevant, 200),
      ndcgAt50: ndcgAt(results, relevant, 50),
      returned: results.length,
      latencyMs: actual.latencyMs,
      errorCategories,
    };
  });
  const errorCategories = {};
  for (const query of perQuery) {
    for (const [category, count] of Object.entries(query.errorCategories)) {
      errorCategories[category] = (errorCategories[category] ?? 0) + count;
    }
  }
  return {
    version: manifest.version,
    queries: perQuery.length,
    macro: {
      precisionAt20: mean(perQuery.map((query) => query.precisionAt20)),
      precisionAt50: mean(perQuery.map((query) => query.precisionAt50)),
      recallAt50: mean(perQuery.map((query) => query.recallAt50)),
      recallAt200: mean(perQuery.map((query) => query.recallAt200)),
      ndcgAt50: mean(perQuery.map((query) => query.ndcgAt50)),
      returned: mean(perQuery.map((query) => query.returned)),
      p95LatencyMs: percentile(
        perQuery.map((query) => query.latencyMs),
        0.95
      ),
    },
    errorCategories,
    perQuery,
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [, , manifestPath, runPath] = process.argv;
  if (!(manifestPath && runPath)) {
    throw new Error(
      "Usage: node scripts/evaluate-semantic-quality.mjs <manifest.json> <run.json>"
    );
  }
  console.log(
    JSON.stringify(
      evaluateSemanticRun(readJson(manifestPath), readJson(runPath)),
      null,
      2
    )
  );
}
