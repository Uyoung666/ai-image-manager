import fs from "node:fs";
import path from "node:path";

const root = path.resolve(
  "reports/search-optimization/implement-recall-20261010"
);
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const revision = process.argv[2] ?? "";
if (revision && !/^[a-z0-9-]+$/.test(revision)) {
  throw new Error("Analysis revision must be a lowercase identifier");
}
const suffix = revision ? `-${revision}` : "";
const registryFile = path.join(root, "study-runs.json");
const finalRegistryFile = path.join(root, `final-runs${suffix}.json`);
const registry = {
  ...(fs.existsSync(registryFile) ? read(registryFile) : {}),
  ...(fs.existsSync(finalRegistryFile) ? read(finalRegistryFile) : {}),
};
const NEGATIVE_CATEGORY_RE = /不要|不含|without|no person/;
const DOCUMENT_CATEGORY_RE = /截图|扫描|档案|文件|信件|表格|网页|screenshot/;
const STYLE_CATEGORY_RE =
  /黑白|black and white|动漫|插画|素描|版画|表情|图标|海报/;
const RELATION_CATEGORY_RE = /拿着|手里|旁|坐|牵|骑|with|surrounded|聚会|人群/;
const SCENE_CATEGORY_RE =
  /田野|树枝|风光|湖泊|房屋|大海|木屋|教堂|树林|建筑|地板|枯树|瀑布|夜景|sailboat|waterfall/;
const definitions = {
  v1: read("scripts/search-benchmark/queries.v1.json"),
  v2: read("scripts/search-benchmark/queries.v2-calibration.json"),
  fresh: read(path.join(root, "queries.v3-sealed.json")),
};
const mean = (values) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
function category(query) {
  if (query.category) {
    return query.category;
  }
  if (NEGATIVE_CATEGORY_RE.test(query.query)) {
    return "negative-constraints";
  }
  if (DOCUMENT_CATEGORY_RE.test(query.query)) {
    return "screenshots-documents";
  }
  if (STYLE_CATEGORY_RE.test(query.query)) {
    return "style";
  }
  if (RELATION_CATEGORY_RE.test(query.query)) {
    return "relationships";
  }
  if (SCENE_CATEGORY_RE.test(query.query)) {
    return "scene";
  }
  return "object-attributes";
}
function summarize(rows, definition) {
  return {
    positiveQueries: rows.filter((row) => row.recallAt50 !== null).length,
    recallAt50: mean(
      rows.map((row) => row.recallAt50).filter((x) => x !== null)
    ),
    ndcgAt10: mean(rows.map((row) => row.ndcgAt10).filter((x) => x !== null)),
    mrr: mean(rows.map((row) => row.mrr).filter((x) => x !== null)),
    hardNegativeQueriesAt10: rows.filter((row) => row.hardNegativeAt10 === 1)
      .length,
    hardNegativeEvaluated: rows.filter((row) => row.hardNegativeAt10 !== null)
      .length,
    emptyFalsePositiveQueries: rows.filter(
      (row) => row.emptyFalsePositive === 1
    ).length,
    emptyQueries: rows.filter((row) => row.emptyFalsePositive !== null).length,
    byCategory: Object.fromEntries(
      [...new Set(definition.queries.map(category))].map((name) => {
        const ids = new Set(
          definition.queries
            .filter((query) => category(query) === name)
            .map((query) => query.id)
        );
        const selected = rows.filter((row) => ids.has(row.id));
        return [
          name,
          {
            queries: selected.length,
            positiveQueries: selected.filter((row) => row.recallAt50 !== null)
              .length,
            recallAt50: mean(
              selected.map((row) => row.recallAt50).filter((x) => x !== null)
            ),
            ndcgAt10: mean(
              selected.map((row) => row.ndcgAt10).filter((x) => x !== null)
            ),
            mrr: mean(selected.map((row) => row.mrr).filter((x) => x !== null)),
            hardNegativeAt10: selected.filter(
              (row) => row.hardNegativeAt10 === 1
            ).length,
            hardNegativeEvaluated: selected.filter(
              (row) => row.hardNegativeAt10 !== null
            ).length,
            emptyFalsePositive: selected.filter(
              (row) => row.emptyFalsePositive === 1
            ).length,
            emptyQueries: selected.filter(
              (row) => row.emptyFalsePositive !== null
            ).length,
          },
        ];
      })
    ),
  };
}
const experiments = {};
for (const [name, dataset] of Object.entries({
  baseline: "v1",
  "baseline-v2": "v2",
  optimization: "v1",
  followup: "v1",
  "current-trace": "v1",
  "current-v2": "v2",
  "legacy-image": "v1",
  "legacy-text": "v1",
  "legacy-parser": "v1",
  "focused-modifiers": "v1",
  "focused-modifiers-v2": "v2",
  "focused-template": "v1",
  "focused-combination": "v1",
  "focused-combination-v2": "v2",
  "object-colors": "v1",
  "object-colors-v2": "v2",
  "object-color-template": "v1",
  "object-color-template-v2": "v2",
  "translation-control": "v1",
  "floor-control": "v1",
  "floor-control-v2": "v2",
  "current-fresh": "fresh",
  "candidate-fresh": "fresh",
  "candidate-v1": "v1",
  "candidate-v2": "v2",
  "final-v1": "v1",
  "final-v2": "v2",
  "provenance-baseline": "v1",
  "provenance-current": "v1",
})) {
  const files = ["development", "holdout"].map((split) =>
    path.join(
      registry[`${name}-${split}`] ?? path.join(root, `${name}-${split}`),
      "report.json"
    )
  );
  if (!files.every(fs.existsSync)) {
    continue;
  }
  const reports = files.map(read);
  experiments[name] = {
    dataset,
    summary: summarize(
      reports.flatMap((run) => run.quality.perQuery),
      definitions[dataset]
    ),
    reports,
  };
}
const comparisons = {};
for (const [name, experiment] of Object.entries(experiments)) {
  const control =
    experiments[
      { v1: "current-trace", v2: "current-v2", fresh: "current-fresh" }[
        experiment.dataset
      ]
    ];
  if (!control || experiment === control) {
    continue;
  }
  const changes = [];
  for (const query of definitions[experiment.dataset].queries) {
    const previous = control.reports
      .flatMap((report) => report.queries)
      .find((row) => row.id === query.id);
    const current = experiment.reports
      .flatMap((report) => report.queries)
      .find((row) => row.id === query.id);
    const added = current.results.filter(
      (id) => !previous.results.includes(id)
    );
    const removed = previous.results.filter(
      (id) => !current.results.includes(id)
    );
    const p = control.reports
      .flatMap((report) => report.quality.perQuery)
      .find((row) => row.id === query.id);
    const c = experiment.reports
      .flatMap((report) => report.quality.perQuery)
      .find((row) => row.id === query.id);
    const newlyHard = current.results
      .slice(0, 10)
      .filter(
        (id) =>
          query.hardNegativeSampleIds.includes(id) &&
          !previous.results.slice(0, 10).includes(id)
      );
    if (
      added.length ||
      removed.length ||
      p.ndcgAt10 !== c.ndcgAt10 ||
      p.mrr !== c.mrr
    ) {
      changes.push({
        id: query.id,
        query: query.query,
        category: category(query),
        recovered: added.filter((id) => query.relevantSampleIds.includes(id)),
        lost: removed.filter((id) => query.relevantSampleIds.includes(id)),
        added,
        addedRanks: added.map((sampleId) => ({
          sampleId,
          rank: current.results.indexOf(sampleId) + 1,
        })),
        removed,
        newHardNegativesAt10: newlyHard,
        newEmptyFalsePositive:
          query.expectEmpty &&
          !previous.results.length &&
          current.results.length > 0,
        before: p,
        after: c,
      });
    }
  }
  comparisons[name] = changes;
}
const lost = [];
if (experiments.baseline && experiments["current-trace"]) {
  for (const query of definitions.v1.queries) {
    const before = experiments.baseline.reports
      .flatMap((report) => report.queries)
      .find((row) => row.id === query.id);
    const after = experiments["current-trace"].reports
      .flatMap((report) => report.queries)
      .find((row) => row.id === query.id);
    for (const sampleId of before.results.filter(
      (id) =>
        query.relevantSampleIds.includes(id) && !after.results.includes(id)
    )) {
      const trace = after.qualityTrace;
      const candidate = trace.candidates.find(
        (row) => row.sampleId === sampleId
      );
      const recall = trace.events.findLast(
        (event) => event.stage === "candidate-recall"
      )?.data;
      const selection = trace.events.findLast(
        (event) => event.stage === "semantic-selection"
      )?.data;
      const primaryIndex = trace.plan.prompts.findIndex(
        (prompt) => prompt.role === "primary"
      );
      const fused = trace.events
        .findLast((event) => event.stage === "primary-and-negative-scores")
        ?.data.fused.find((row) => row.photoId === candidate.photoId);
      const scored = selection?.penalized.find(
        (row) => row.photoId === candidate.photoId
      );
      const union = recall?.resultSets.some((set) =>
        set.some((row) => row.photoId === candidate.photoId)
      );
      lost.push({
        id: query.id,
        query: query.query,
        sampleId,
        photoId: candidate.photoId,
        plan: trace.plan,
        fullScanSimilarities: candidate.similarities,
        primaryCosine: candidate.similarities[primaryIndex],
        inPrimaryRecall: recall?.resultSets[primaryIndex]?.some(
          (row) => row.photoId === candidate.photoId
        ),
        inAnyRecall: union,
        rawPrimary: fused?.primarySimilarity,
        adjustedPrimary: scored?.primarySimilarity,
        supportingGroups: scored?.supportingGroups,
        strongCutoff: selection?.selection.strongCutoff,
        supportCutoff: selection?.selection.supportCutoff,
        firstIrreversibleLoss: union
          ? "semantic-relevance-selection"
          : "candidate-recall",
        baselineRank: before.results.indexOf(sampleId) + 1,
        currentRank: null,
        tagEvidence: "none in frozen quality fixture",
      });
    }
  }
}
const compact = Object.fromEntries(
  Object.entries(experiments).map(([name, entry]) => [
    name,
    {
      dataset: entry.dataset,
      summary: entry.summary,
      sourceHashes: entry.reports.map((report) => report.sourceTreeHash),
      definitions: entry.reports.map((report) => report.definitionHash),
    },
  ])
);
fs.writeFileSync(
  path.join(root, `analysis${suffix}.json`),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      experiments: compact,
      comparisons,
      lostHistoricalPositives: lost,
    },
    null,
    2
  )
);
console.log(
  JSON.stringify(
    {
      experiments: compact,
      changes: Object.fromEntries(
        Object.entries(comparisons).map(([name, rows]) => [
          name,
          rows.map((row) => ({
            id: row.id,
            recovered: row.recovered,
            lost: row.lost,
            newHardNegatives: row.newHardNegativesAt10,
            newEmptyFP: row.newEmptyFalsePositive,
            ndcgDelta: row.after.ndcgAt10 - row.before.ndcgAt10,
          })),
        ])
      ),
    },
    null,
    2
  )
);
