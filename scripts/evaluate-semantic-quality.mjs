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
import {
  summarizeDistribution,
  summarizeIntegerDistribution,
} from "./siglip-v1-baseline/statistics.mjs";

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function mean(values) {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

/**
 * Historical repository metric. Its denominator shrinks to the returned page
 * size, so it is not standard fixed-cutoff Precision@K. Kept for compatibility.
 */
function legacyPrecisionAt(results, relevant, cutoff) {
  const page = results.slice(0, cutoff);
  return ratio(
    page.filter((contentHash) => relevant.has(contentHash)).length,
    Math.min(cutoff, page.length)
  );
}

function fixedCutoffPrecisionAt(results, relevant, cutoff) {
  return ratio(
    results.slice(0, cutoff).filter((contentHash) => relevant.has(contentHash))
      .length,
    cutoff
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

function hitAt(results, relevant, cutoff) {
  return Number(
    results.slice(0, cutoff).some((contentHash) => relevant.has(contentHash))
  );
}

function reciprocalRank(results, relevant) {
  const index = results.findIndex((contentHash) => relevant.has(contentHash));
  return index >= 0 ? 1 / (index + 1) : 0;
}

function hardNegativeFalsePositiveAt(results, hardNegatives, cutoff) {
  return Number(
    results
      .slice(0, cutoff)
      .some((contentHash) => hardNegatives.has(contentHash))
  );
}

const latencyPhaseNames = [
  "textEncodingMs",
  "scoringMs",
  "filteringMs",
  "sortingMs",
  "endToEndSearchMs",
];

function getLatencyPhases(actual) {
  const phases = actual.latencyPhases ?? {};
  const endToEndSearchMs = phases.endToEndSearchMs ?? actual.latencyMs ?? 0;
  return {
    textEncodingMs: phases.textEncodingMs ?? 0,
    scoringMs: phases.scoringMs ?? 0,
    filteringMs: phases.filteringMs ?? 0,
    sortingMs: phases.sortingMs ?? 0,
    endToEndSearchMs,
  };
}

export function evaluateSemanticRun(manifest, run) {
  const runById = new Map(run.queries.map((query) => [query.id, query]));
  const perQuery = manifest.queries.map((query) => {
    const actual = runById.get(query.id);
    if (!actual) {
      throw new Error(`Missing benchmark run for query id: ${query.id}`);
    }
    const relevant = new Set(query.relevantContentHashes);
    const hardNegatives = new Set(query.hardNegativeContentHashes ?? []);
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
    const latencyPhases = getLatencyPhases(actual);
    return {
      id: query.id,
      category: query.category,
      intent: query.intent,
      query: query.query,
      precisionAt20: legacyPrecisionAt(results, relevant, 20),
      precisionAt50: legacyPrecisionAt(results, relevant, 50),
      recallAt50: recallAt(results, relevant, 50),
      recallAt200: recallAt(results, relevant, 200),
      ndcgAt50: ndcgAt(results, relevant, 50),
      hitAt1: hitAt(results, relevant, 1),
      hitAt3: hitAt(results, relevant, 3),
      hitAt5: hitAt(results, relevant, 5),
      hitAt10: hitAt(results, relevant, 10),
      reciprocalRank: reciprocalRank(results, relevant),
      recallAt5: recallAt(results, relevant, 5),
      recallAt10: recallAt(results, relevant, 10),
      fixedCutoffPrecisionAt5: fixedCutoffPrecisionAt(results, relevant, 5),
      fixedCutoffPrecisionAt10: fixedCutoffPrecisionAt(results, relevant, 10),
      fixedCutoffPrecisionAt20: fixedCutoffPrecisionAt(results, relevant, 20),
      fixedCutoffPrecisionAt50: fixedCutoffPrecisionAt(results, relevant, 50),
      hardNegativeFalsePositiveAt1: hardNegativeFalsePositiveAt(
        results,
        hardNegatives,
        1
      ),
      hardNegativeFalsePositiveAt3: hardNegativeFalsePositiveAt(
        results,
        hardNegatives,
        3
      ),
      hardNegativeFalsePositiveAt5: hardNegativeFalsePositiveAt(
        results,
        hardNegatives,
        5
      ),
      hardNegativeFalsePositiveAt10: hardNegativeFalsePositiveAt(
        results,
        hardNegatives,
        10
      ),
      hardNegativeCount: hardNegatives.size,
      returned: results.length,
      emptyResult: results.length === 0,
      latencyMs: latencyPhases.endToEndSearchMs,
      latencyPhases,
      errorCategories,
    };
  });
  const errorCategories = {};
  for (const query of perQuery) {
    for (const [category, count] of Object.entries(query.errorCategories)) {
      errorCategories[category] = (errorCategories[category] ?? 0) + count;
    }
  }
  const phaseDistributions = Object.fromEntries(
    latencyPhaseNames.map((phase) => [
      phase,
      summarizeDistribution(
        perQuery.map((query) => query.latencyPhases[phase])
      ),
    ])
  );
  const hardNegativeQueries = perQuery.filter(
    (query) => query.hardNegativeCount > 0
  );
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
      p95LatencyMs: phaseDistributions.endToEndSearchMs.p95,
      emptyResults: perQuery.filter((query) => query.emptyResult).length,
      emptyResultRate: ratio(
        perQuery.filter((query) => query.emptyResult).length,
        perQuery.length
      ),
      hitAt1: mean(perQuery.map((query) => query.hitAt1)),
      hitAt3: mean(perQuery.map((query) => query.hitAt3)),
      hitAt5: mean(perQuery.map((query) => query.hitAt5)),
      hitAt10: mean(perQuery.map((query) => query.hitAt10)),
      meanReciprocalRank: mean(perQuery.map((query) => query.reciprocalRank)),
      recallAt5: mean(perQuery.map((query) => query.recallAt5)),
      recallAt10: mean(perQuery.map((query) => query.recallAt10)),
      fixedCutoffPrecisionAt5: mean(
        perQuery.map((query) => query.fixedCutoffPrecisionAt5)
      ),
      fixedCutoffPrecisionAt10: mean(
        perQuery.map((query) => query.fixedCutoffPrecisionAt10)
      ),
      fixedCutoffPrecisionAt20: mean(
        perQuery.map((query) => query.fixedCutoffPrecisionAt20)
      ),
      fixedCutoffPrecisionAt50: mean(
        perQuery.map((query) => query.fixedCutoffPrecisionAt50)
      ),
      hardNegativeFalsePositiveRateAt1: mean(
        hardNegativeQueries.map((query) => query.hardNegativeFalsePositiveAt1)
      ),
      hardNegativeFalsePositiveRateAt3: mean(
        hardNegativeQueries.map((query) => query.hardNegativeFalsePositiveAt3)
      ),
      hardNegativeFalsePositiveRateAt5: mean(
        hardNegativeQueries.map((query) => query.hardNegativeFalsePositiveAt5)
      ),
      hardNegativeFalsePositiveRateAt10: mean(
        hardNegativeQueries.map((query) => query.hardNegativeFalsePositiveAt10)
      ),
      hardNegativeQueryCount: hardNegativeQueries.length,
    },
    returnedCountDistribution: summarizeIntegerDistribution(
      perQuery.map((query) => query.returned)
    ),
    latencyPhases: phaseDistributions,
    metricSemantics: {
      precisionAt20: {
        status: "legacy-nonstandard",
        denominator: "min(20, returnedCount)",
        canonicalReplacement: "fixedCutoffPrecisionAt20",
      },
      precisionAt50: {
        status: "legacy-nonstandard",
        denominator: "min(50, returnedCount)",
        canonicalReplacement: "fixedCutoffPrecisionAt50",
      },
      p95LatencyMs: {
        status: "legacy-compatible",
        meaning: "end-to-end benchmark search P95",
        canonicalReplacement: "latencyPhases.endToEndSearchMs.p95",
      },
      hardNegativeFalsePositiveRate: {
        status: "canonical",
        denominator: "queries with at least one declared hard negative",
        meaning:
          "fraction of eligible queries whose top-K returned results contain at least one declared similar-but-irrelevant sample",
        direction: "lower-is-better",
      },
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
