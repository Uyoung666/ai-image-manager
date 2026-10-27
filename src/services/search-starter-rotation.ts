import type {
  SearchStarter,
  SearchStarterSource,
} from "@/types/search-starters";

const SOURCE_ORDER: SearchStarterSource[] = [
  "library",
  "interest",
  "rediscovery",
];
const BATCH_SIZE = 4;

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function starterTopics(starter: SearchStarter): string[] {
  return starter.topics.map(normalized);
}

function sameIdea(left: SearchStarter, right: SearchStarter): boolean {
  return (
    left.key === right.key || normalized(left.text) === normalized(right.text)
  );
}

function overlaps(left: SearchStarter, right: SearchStarter): boolean {
  const topics = starterTopics(left);
  return (
    sameIdea(left, right) ||
    starterTopics(right).some((topic) => topics.includes(topic))
  );
}

interface RotationCandidate {
  freshness: number[];
  rank: number;
  starter: SearchStarter;
}

function compareScores(left: number[], right: number[]): number {
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}

function sourceCoverage(selected: SearchStarter[]): number {
  return SOURCE_ORDER.reduce(
    (sum, source) =>
      sum +
      Math.min(
        source === "library" ? 2 : 1,
        selected.filter((item) => item.source === source).length
      ),
    0
  );
}

function rotationCandidate(
  starter: SearchStarter,
  rank: number,
  previous: SearchStarter[],
  recent: SearchStarter[]
): RotationCandidate {
  const topicAge = recent.findIndex((item) => overlaps(item, starter));
  const ideaAge = recent.findIndex((item) => sameIdea(item, starter));
  return {
    starter,
    rank,
    freshness: [
      Number(!previous.some((item) => overlaps(item, starter))),
      Number(!previous.some((item) => sameIdea(item, starter))),
      Number(topicAge < 0),
      Number(ideaAge < 0),
      topicAge < 0 ? recent.length : topicAge,
      ideaAge < 0 ? recent.length : ideaAge,
    ],
  };
}

function selectCovers(
  selected: SearchStarter[],
  previous: SearchStarter[],
  recentIds: Array<number | undefined>
): { ids: Array<number | undefined>; score: number[] } {
  const previousIds = new Set(
    previous.map((item) => item.previewPhotoIds?.[0])
  );
  let best: Array<number | undefined> = [];
  let bestScore = [-1];
  const choices = selected.map(
    (item) => item.previewPhotoIds?.slice(0, 3) ?? []
  );
  const ageOf = (id: number) => {
    const age = recentIds.indexOf(id);
    return age < 0 ? recentIds.length : age;
  };
  const upperBound = [
    Math.min(
      choices.filter((ids) => ids.length).length,
      new Set(choices.flat()).size
    ),
    choices.filter((ids) => ids.some((id) => !previousIds.has(id))).length,
    choices.filter((ids) => ids.some((id) => !recentIds.includes(id))).length,
    choices.reduce((sum, ids) => sum + Math.max(0, ...ids.map(ageOf)), 0),
  ];
  const visit = (ids: Array<number | undefined>) => {
    if (bestScore[0] >= 0 && compareScores(bestScore, upperBound) === 0) {
      return;
    }
    if (ids.length === selected.length) {
      const covers = ids.filter((id): id is number => id !== undefined);
      const score = [
        new Set(covers).size,
        covers.filter((id) => !previousIds.has(id)).length,
        covers.filter((id) => !recentIds.includes(id)).length,
        covers.reduce((sum, id) => sum + ageOf(id), 0),
      ];
      if (bestScore[0] < 0 || compareScores(score, bestScore) > 0) {
        best = [...ids];
        bestScore = score;
      }
      return;
    }
    const options = choices[ids.length];
    for (const id of options?.length ? options : [undefined]) {
      ids.push(id);
      visit(ids);
      ids.pop();
    }
  };
  visit([]);
  return {
    score: bestScore,
    ids: best,
  };
}

function applyCoverIds(
  selected: SearchStarter[],
  ordered: Array<{ index: number }>,
  ids: Array<number | undefined>
): SearchStarter[] {
  const batch = [...selected];
  for (const [position, item] of ordered.entries()) {
    const starter = selected[item.index];
    const id = ids[position];
    if (id !== undefined) {
      batch[item.index] = {
        ...starter,
        previewPhotoIds: [
          id,
          ...(starter.previewPhotoIds ?? []).filter((other) => other !== id),
        ],
      };
    }
  }
  return batch;
}

function selectSources(
  selected: SearchStarter[],
  aliases: Map<SearchStarter, RotationCandidate[]>
) {
  let best = selected;
  let coverage = -1;
  let bestRank = Number.POSITIVE_INFINITY;
  const visit = (batch: SearchStarter[], rank: number) => {
    if (batch.length === selected.length) {
      const value = sourceCoverage(batch);
      if (value > coverage || (value === coverage && rank < bestRank)) {
        best = [...batch];
        coverage = value;
        bestRank = rank;
      }
      return;
    }
    for (const candidate of aliases.get(selected[batch.length]) ?? []) {
      batch.push(candidate.starter);
      visit(batch, rank + candidate.rank);
      batch.pop();
    }
  };
  visit([], 0);
  return { batch: best, coverage, rank: bestRank };
}

/** Fresh themes outrank source quotas; prefer the least recently seen on exhaustion. */
export function selectStarterBatch(
  candidates: SearchStarter[],
  previous: SearchStarter[] = [],
  recent: SearchStarter[] = [],
  recentCoverIds: Array<number | undefined> = recent.map(
    (item) => item.previewPhotoIds?.[0]
  )
): SearchStarter[] {
  // Source aliases share eligibility and cover choices; enumerate their themes once.
  const groups = new Map<string, RotationCandidate>();
  const aliases = new Map<SearchStarter, RotationCandidate[]>();
  for (const [rank, starter] of candidates.entries()) {
    const signature = JSON.stringify([
      starter.key,
      normalized(starter.text),
      starterTopics(starter),
      starter.kind,
      starter.query,
      starter.filters,
      starter.previewPhotoIds,
    ]);
    const candidate = rotationCandidate(starter, rank, previous, recent);
    const existing = groups.get(signature);
    if (existing) {
      aliases.get(existing.starter)?.push(candidate);
    } else {
      groups.set(signature, candidate);
      aliases.set(starter, [candidate]);
    }
  }
  const pool = [...groups.values()];
  const coverKeys = new Map(
    candidates.map((item) => [item, (item.previewPhotoIds ?? []).join(",")])
  );
  const coverCache = new Map<string, ReturnType<typeof selectCovers>>();
  const coversFor = (selected: SearchStarter[]) => {
    const ordered = selected
      .map((starter, index) => ({
        starter,
        index,
        key: coverKeys.get(starter) ?? "",
      }))
      .sort((left, right) => left.key.localeCompare(right.key));
    const key = ordered.map((item) => item.key).join("|");
    let covers = coverCache.get(key);
    if (!covers) {
      covers = selectCovers(
        ordered.map((item) => item.starter),
        previous,
        recentCoverIds
      );
      coverCache.set(key, covers);
    }
    return { ordered, covers };
  };
  let best: SearchStarter[] = [];
  let bestScore: number[] = [];
  const visit = (
    start: number,
    selected: SearchStarter[],
    freshness: number[]
  ) => {
    const prefix = [
      selected.length,
      ...freshness,
      selected.filter((item) => !item.kind || item.kind === "semantic").length,
    ];
    if (
      best.length === 0 ||
      compareScores(prefix, bestScore.slice(0, prefix.length)) >= 0
    ) {
      const { ordered, covers } = coversFor(selected);
      const sources = selectSources(selected, aliases);
      const score = [
        ...prefix,
        ...covers.score,
        sources.coverage,
        -sources.rank,
      ];
      if (best.length === 0 || compareScores(score, bestScore) > 0) {
        best = applyCoverIds(sources.batch, ordered, covers.ids);
        bestScore = score;
      }
    }
    if (selected.length === BATCH_SIZE) {
      return;
    }
    for (let index = start; index < pool.length; index++) {
      const candidate = pool[index];
      if (selected.some((item) => overlaps(item, candidate.starter))) {
        continue;
      }
      selected.push(candidate.starter);
      visit(
        index + 1,
        selected,
        freshness.map((value, metric) => value + candidate.freshness[metric])
      );
      selected.pop();
    }
  };
  visit(0, [], [0, 0, 0, 0, 0, 0]);
  return best.sort(
    (left, right) =>
      SOURCE_ORDER.indexOf(left.source) - SOURCE_ORDER.indexOf(right.source)
  );
}

/** Most recent ideas first; aliases never consume multiple places in the cooldown. */
export function rememberStarterBatch(
  recent: SearchStarter[],
  batch: SearchStarter[]
): SearchStarter[] {
  return [
    ...batch,
    ...recent.filter((item) => !batch.some((shown) => sameIdea(shown, item))),
  ].slice(0, 48);
}
