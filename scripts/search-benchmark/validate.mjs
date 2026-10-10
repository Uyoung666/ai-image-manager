/** Fail closed when query judgments cross the frozen near-duplicate split. */
export function validateSearchDefinition(definition, manifest) {
  const samples = new Map(
    manifest.samples.map((sample) => [sample.id, sample])
  );
  const clusters = new Map();
  for (const sample of manifest.samples) {
    const cluster = sample.duplicateClusterId;
    if (
      !cluster ||
      (clusters.has(cluster) && clusters.get(cluster) !== sample.split)
    ) {
      throw new Error(`Invalid near-duplicate split: ${sample.id}`);
    }
    clusters.set(cluster, sample.split);
  }
  const ids = new Set();
  for (const query of definition.queries) {
    if (ids.has(query.id)) {
      throw new Error(`Duplicate query: ${query.id}`);
    }
    ids.add(query.id);
    const judgments = new Set();
    for (const id of [
      ...query.relevantSampleIds,
      ...query.hardNegativeSampleIds,
      ...query.unjudgedSampleIds,
    ]) {
      if (samples.get(id)?.split !== query.split || judgments.has(id)) {
        throw new Error(`Invalid judgment ${query.id}: ${id}`);
      }
      judgments.add(id);
    }
    if (query.expectEmpty && query.relevantSampleIds.length) {
      throw new Error(`Empty query has positive judgments: ${query.id}`);
    }
  }
  for (const split of ["development", "holdout"]) {
    if (
      definition.queries.filter((query) => query.split === split).length < 30
    ) {
      throw new Error(`At least 30 queries required for ${split}`);
    }
  }
}
