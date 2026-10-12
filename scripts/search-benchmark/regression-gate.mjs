import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMMIT_RE = /^[a-f0-9]{40}$/;

function isVerifiedHead(report) {
  const snapshot = report.headSnapshot ?? report.sourceSnapshot;
  return (
    (snapshot?.kind === "git-head" || snapshot?.kind === "git-revision") &&
    COMMIT_RE.test(snapshot.commit) &&
    snapshot.sourceTreeHash === report.sourceTreeHash
  );
}

function validateComparison(
  definition,
  definitionHash,
  baseline,
  candidate,
  options
) {
  if (
    baseline.definitionHash !== definitionHash ||
    candidate.definitionHash !== definitionHash
  ) {
    throw new Error("Query definitions differ");
  }
  if (
    baseline.split !== candidate.split ||
    !definition.queries.some((row) => row.split === candidate.split)
  ) {
    throw new Error("Missing or mismatched query splits");
  }
  if (
    baseline.scope !== "production-api-real-images" ||
    candidate.scope !== "production-api-real-images"
  ) {
    throw new Error("Quality gates require real-image production API reports");
  }
  const verifiedHead = isVerifiedHead(baseline);
  if (options.requireHead && !verifiedHead) {
    throw new Error("Quality baseline must be a verified frozen HEAD snapshot");
  }
  return verifiedHead;
}

/** Compare individual judged results; macro improvements cannot hide a loss. */
export function checkSearchRegressions(
  definition,
  baseline,
  candidate,
  options = {}
) {
  const definitionHash = createHash("sha256")
    .update(JSON.stringify(definition))
    .digest("hex");
  const verifiedHead = validateComparison(
    definition,
    definitionHash,
    baseline,
    candidate,
    options
  );
  const regressions = [];
  for (const query of definition.queries.filter(
    (row) => row.split === candidate.split
  )) {
    const before = baseline.queries.find((row) => row.id === query.id);
    const after = candidate.queries.find((row) => row.id === query.id);
    const beforeMetrics = baseline.quality.perQuery.find(
      (row) => row.id === query.id
    );
    const afterMetrics = candidate.quality.perQuery.find(
      (row) => row.id === query.id
    );
    if (!(before && after && beforeMetrics && afterMetrics)) {
      throw new Error(`Missing comparison for ${query.id}`);
    }
    // Historical HEAD has no completion contract. Keep its state unknown;
    // compare judged results only, never use it as successful speed evidence.
    const historicalHead = before.completion === "legacy" && verifiedHead;
    if (before.completion !== "complete" && !historicalHead) {
      throw new Error(`Incomplete HEAD baseline for ${query.id}`);
    }
    const relevant = new Set(query.relevantSampleIds);
    const hard = new Set(query.hardNegativeSampleIds);
    const oldResults = [...new Set(before.results)];
    const newResults = [...new Set(after.results)];
    const newTop50 = new Set(newResults.slice(0, 50));
    const oldHardTop10 = new Set(
      oldResults.slice(0, 10).filter((id) => hard.has(id))
    );
    const lostRelevant = oldResults
      .slice(0, 50)
      .filter((id) => relevant.has(id) && !newTop50.has(id));
    const addedHardNegatives = newResults
      .slice(0, 10)
      .filter((id) => hard.has(id) && !oldHardTop10.has(id));
    const decreasedMetrics = ["recallAt50", "ndcgAt10", "mrr"].filter(
      (name) =>
        typeof beforeMetrics[name] === "number" &&
        typeof afterMetrics[name] === "number" &&
        afterMetrics[name] + 1e-12 < beforeMetrics[name]
    );
    const incomplete = after.completion !== "complete";
    const newEmptyFalsePositive =
      query.expectEmpty && !oldResults.length && newResults.length > 0;
    if (
      lostRelevant.length ||
      addedHardNegatives.length ||
      decreasedMetrics.length ||
      incomplete ||
      newEmptyFalsePositive
    ) {
      regressions.push({
        id: query.id,
        query: query.query,
        lostRelevant,
        addedHardNegatives,
        decreasedMetrics,
        incomplete,
        newEmptyFalsePositive,
        before: beforeMetrics,
        after: afterMetrics,
      });
    }
  }
  return {
    passed: regressions.length === 0,
    split: candidate.split,
    baselineCommit:
      (baseline.headSnapshot ?? baseline.sourceSnapshot)?.commit ?? null,
    baselineSourceHash: baseline.sourceHash,
    candidateSourceHash: candidate.sourceHash,
    definitionHash,
    regressions,
  };
}

/** Model scores are observations, not proof that the search contract failed. */
export function assessSearchQuality(gates, policy = "strict") {
  if (!["strict", "current-model"].includes(policy)) {
    throw new Error(`Unknown quality policy: ${policy}`);
  }
  const differences = gates.flatMap((gate) => gate.regressions);
  const failures = differences.filter(
    (row) => policy === "strict" || row.incomplete
  );
  return {
    policy,
    accepted: failures.length === 0,
    noQualityRegressions: gates.every((gate) => gate.passed),
    failures,
    warnings: differences.filter((row) => !failures.includes(row)),
    limitations:
      policy === "current-model"
        ? [
            "Numerical quality differences remain reported; this policy does not prove a model ceiling or software correctness.",
            "Query planning, filters, scoring, pagination and cancellation require separate correctness tests and review.",
          ]
        : [],
  };
}

/** Numeric model warnings cannot satisfy the separate software contract gate. */
export function assessSearchCorrectness(reports) {
  const required = [
    "exactPaginationReachability",
    "semanticPaginationReachability",
    "pageSizeInvariant",
    "hardFilters",
    "exactTotalAndCompletion",
  ];
  const failures = reports.flatMap((report) => {
    const evidence = report.correctness;
    if (
      !evidence ||
      evidence.passed !== true ||
      typeof report.sourceTreeHash !== "string" ||
      !report.sourceTreeHash ||
      evidence.sourceTreeHash !== report.sourceTreeHash
    ) {
      return [
        {
          label: report.label,
          reason: "missing-or-mismatched-correctness-evidence",
        },
      ];
    }
    return required
      .filter((check) => evidence.checks?.[check] !== true)
      .map((check) => ({ label: report.label, reason: check }));
  });
  return {
    passed: reports.length > 0 && failures.length === 0,
    failures,
    sourceTreeHashes: reports.map((report) => report.sourceTreeHash),
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [
    baselinePath,
    candidatePath,
    definitionPath = "scripts/search-benchmark/queries.v1.json",
  ] = process.argv.slice(2);
  if (!(baselinePath && candidatePath)) {
    throw new Error(
      "Usage: regression-gate.mjs <HEAD report.json> <candidate report.json> [definition.json]"
    );
  }
  const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
  const result = checkSearchRegressions(
    read(definitionPath),
    read(baselinePath),
    read(candidatePath),
    { requireHead: true }
  );
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.passed ? 0 : 1;
}
