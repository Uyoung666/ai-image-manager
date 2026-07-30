/**
 * Read-only hybrid-search ablation and fixed-grid calibration.
 *
 * Usage:
 *   node scripts/calibrate-hybrid-search.mjs <manifest.json> <candidates.json>
 *
 * Candidate files contain one entry per benchmark query:
 * {
 *   "queries": [{
 *     "id": "bicycle",
 *     "latencyMs": 260,
 *     "candidates": [{
 *       "contentHash": "...",
 *       "normalizedSemantic": 0.82,
 *       "tagSupport": 0.75,
 *       "autoTagConfidence": 0.8,
 *       "semanticAccepted": false,
 *       "supportEligible": true,
 *       "trustedExact": false
 *     }]
 *   }]
 * }
 *
 * This script never opens or changes the application database or vector index.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { evaluateSemanticRun } from "./evaluate-semantic-quality.mjs";

const SEMANTIC_WEIGHTS = [0.6, 0.65, 0.7, 0.75, 0.8, 0.85];
const AUTO_RESCUE_THRESHOLDS = [0.65, 0.75, 0.85];
const DEFAULT_CONFIG = {
  semanticWeight: 0.7,
  tagWeight: 0.3,
  autoRescueThreshold: 0.75,
};

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function tagStrength(candidate) {
  if (candidate.trustedExact) {
    return 1;
  }
  if (
    typeof candidate.autoTagConfidence === "number" &&
    candidate.autoTagConfidence < 0.55
  ) {
    return 0;
  }
  if (typeof candidate.tagSupport === "number") {
    return clamp(candidate.tagSupport, 0, 1);
  }
  if (typeof candidate.autoTagConfidence !== "number") {
    return 0;
  }
  return 0.5 + 0.5 * clamp((candidate.autoTagConfidence - 0.55) / 0.4, 0, 1);
}

function compareRanked(left, right) {
  return (
    Number(right.trustedExact) - Number(left.trustedExact) ||
    right.score - left.score ||
    (right.normalizedSemantic ?? 0) - (left.normalizedSemantic ?? 0) ||
    left.contentHash.localeCompare(right.contentHash)
  );
}

function buildRun(candidateRun, mode, config) {
  return {
    queries: candidateRun.queries.map((query) => {
      const candidates = query.candidates
        .map((candidate) => {
          const semantic = clamp(candidate.normalizedSemantic ?? 0, 0, 1);
          const tag = tagStrength(candidate);
          let accepted = false;
          let score = 0;

          if (mode === "semantic-only") {
            accepted = Boolean(candidate.semanticAccepted);
            score = semantic;
          } else if (mode === "tag-only") {
            accepted =
              Boolean(candidate.trustedExact) ||
              (tag > 0 &&
                (typeof candidate.autoTagConfidence !== "number" ||
                  candidate.autoTagConfidence >= 0.55));
            score = tag;
          } else {
            const rescued =
              candidate.supportEligible &&
              typeof candidate.autoTagConfidence === "number" &&
              candidate.autoTagConfidence >= config.autoRescueThreshold;
            accepted =
              Boolean(candidate.trustedExact) ||
              Boolean(candidate.semanticAccepted) ||
              Boolean(rescued);
            score = config.semanticWeight * semantic + config.tagWeight * tag;
          }

          return { ...candidate, score, accepted };
        })
        .filter((candidate) => candidate.accepted)
        .sort(compareRanked);

      return {
        id: query.id,
        latencyMs: query.latencyMs ?? 0,
        results: candidates.map((candidate) => candidate.contentHash),
      };
    }),
  };
}

function compareConfigurations(left, right) {
  return (
    right.report.macro.recallAt50 - left.report.macro.recallAt50 ||
    right.report.macro.ndcgAt50 - left.report.macro.ndcgAt50 ||
    right.report.macro.precisionAt50 - left.report.macro.precisionAt50 ||
    Math.abs(left.config.semanticWeight - DEFAULT_CONFIG.semanticWeight) -
      Math.abs(right.config.semanticWeight - DEFAULT_CONFIG.semanticWeight) ||
    Math.abs(
      left.config.autoRescueThreshold - DEFAULT_CONFIG.autoRescueThreshold
    ) -
      Math.abs(
        right.config.autoRescueThreshold - DEFAULT_CONFIG.autoRescueThreshold
      )
  );
}

export function calibrateHybridSearch(manifest, candidateRun) {
  const grid = [];
  for (const semanticWeight of SEMANTIC_WEIGHTS) {
    for (const autoRescueThreshold of AUTO_RESCUE_THRESHOLDS) {
      const config = {
        semanticWeight,
        tagWeight: Number((1 - semanticWeight).toFixed(2)),
        autoRescueThreshold,
      };
      const report = evaluateSemanticRun(
        manifest,
        buildRun(candidateRun, "hybrid", config)
      );
      grid.push({
        config,
        report,
        meetsPrecision:
          report.macro.precisionAt20 >= 0.95 &&
          report.macro.precisionAt50 >= 0.9,
      });
    }
  }

  const eligible = grid
    .filter((entry) => entry.meetsPrecision)
    .sort(compareConfigurations);
  const fallback = grid.find(
    (entry) =>
      entry.config.semanticWeight === DEFAULT_CONFIG.semanticWeight &&
      entry.config.autoRescueThreshold === DEFAULT_CONFIG.autoRescueThreshold
  );
  const selected = eligible[0] ?? fallback;
  const semanticOnly = evaluateSemanticRun(
    manifest,
    buildRun(candidateRun, "semantic-only", DEFAULT_CONFIG)
  );
  const tagOnly = evaluateSemanticRun(
    manifest,
    buildRun(candidateRun, "tag-only", DEFAULT_CONFIG)
  );

  return {
    selected: {
      ...selected,
      usedFallback: eligible.length === 0,
    },
    ablation: {
      semanticOnly: semanticOnly.macro,
      tagOnly: tagOnly.macro,
      hybrid: selected.report.macro,
      hybridNdcgBeatsBoth:
        selected.report.macro.ndcgAt50 > semanticOnly.macro.ndcgAt50 &&
        selected.report.macro.ndcgAt50 > tagOnly.macro.ndcgAt50,
    },
    grid: grid.map(({ config, report, meetsPrecision }) => ({
      config,
      meetsPrecision,
      macro: report.macro,
    })),
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [, , manifestPath, candidatesPath] = process.argv;
  if (!(manifestPath && candidatesPath)) {
    throw new Error(
      "Usage: node scripts/calibrate-hybrid-search.mjs <manifest.json> <candidates.json>"
    );
  }
  console.log(
    JSON.stringify(
      calibrateHybridSearch(readJson(manifestPath), readJson(candidatesPath)),
      null,
      2
    )
  );
}
