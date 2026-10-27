import type {
  SearchStarter,
  SearchStarterInput,
} from "@/types/search-starters";

export interface StarterPhotoEvidence {
  dateTaken: number | null;
  favorite: boolean;
  id: number;
  lastViewedAt: number | null;
  views: number;
}

export interface StarterTagEvidence {
  manual: boolean;
  name: string;
  photoId: number;
}

export interface StarterConcept {
  category: string;
  en: string;
  zh: string;
}

export interface StarterCandidate extends SearchStarter {
  photoIds: number[];
  score: number;
}

export function localSearchDay(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function dayOrder(key: string): number {
  let value = 7;
  for (const character of key) {
    value = (value * 31 + character.charCodeAt(0)) % 2_147_483_647;
  }
  return value;
}

function photoInterest(
  photo: StarterPhotoEvidence | undefined,
  now: Date
): number {
  if (!photo) {
    return 0;
  }
  const recentView =
    photo.lastViewedAt && now.getTime() - photo.lastViewedAt < 30 * 86_400_000;
  return (
    Number(photo.favorite) * 2 +
    Math.log1p(photo.views) +
    Number(Boolean(recentView))
  );
}

type ThemeGroup = [string, { ids: Set<number>; manual: number }];

function canRediscover(
  photo: StarterPhotoEvidence | undefined,
  now: Date
): boolean {
  return Boolean(
    photo?.dateTaken &&
      photo.dateTaken < now.getTime() - 365 * 86_400_000 &&
      (!photo.lastViewedAt ||
        photo.lastViewedAt < now.getTime() - 30 * 86_400_000)
  );
}

function rediscoveryCandidate(
  base: StarterCandidate,
  photoMap: Map<number, StarterPhotoEvidence>,
  language: "zh" | "en",
  hasTime: boolean,
  now: Date
): StarterCandidate | undefined {
  const oldIds = base.photoIds.filter((id) =>
    canRediscover(photoMap.get(id), now)
  );
  if (oldIds.length < 2) {
    return;
  }
  const months = new Map<string, number[]>();
  for (const id of oldIds) {
    const date = new Date(photoMap.get(id)?.dateTaken ?? 0);
    const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    months.set(month, [...(months.get(month) ?? []), id]);
  }
  const anchor = [...months.entries()].sort(
    (a, b) => b[1].length - a[1].length
  )[0];
  const candidate: StarterCandidate = {
    ...base,
    source: "rediscovery",
    score: base.score + Math.log1p(oldIds.length),
  };
  if (!anchor || anchor[1].length < 2 || hasTime) {
    return candidate;
  }
  const [year, month] = anchor[0].split("-").map(Number);
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0);
  const monthLabel = new Intl.DateTimeFormat(language, {
    year: "numeric",
    month: "long",
  }).format(start);
  return {
    ...candidate,
    key: `${base.key}:${anchor[0]}`,
    query: base.text,
    text:
      language === "zh"
        ? `${monthLabel}的${base.text}`
        : `${base.text} in ${monthLabel}`,
    filters: { dateFrom: localSearchDay(start), dateTo: localSearchDay(end) },
    photoIds: anchor[1],
  };
}

function combineThemes(
  themes: ThemeGroup[],
  concepts: Map<string, StarterConcept>,
  add: (names: string[], ids: number[], manual: number) => void
): void {
  for (let left = 0; left < themes.length; left++) {
    for (let right = left + 1; right < themes.length; right++) {
      const [nameA, groupA] = themes[left];
      const [nameB, groupB] = themes[right];
      const categoryA = concepts.get(nameA)?.category;
      const categoryB = concepts.get(nameB)?.category;
      if (!(categoryA && categoryB) || categoryA === categoryB) {
        continue;
      }
      add(
        [nameA, nameB],
        [...groupA.ids].filter((id) => groupB.ids.has(id)),
        groupA.manual + groupB.manual
      );
    }
  }
}

/** Bounded, reproducible candidates; combinations require the very same photos. */
export function buildStarterCandidates(
  input: SearchStarterInput,
  photos: StarterPhotoEvidence[],
  evidence: StarterTagEvidence[],
  vocabulary: StarterConcept[],
  now = new Date()
): StarterCandidate[] {
  const concepts = new Map(vocabulary.map((concept) => [concept.zh, concept]));
  const photoMap = new Map(photos.map((photo) => [photo.id, photo]));
  const grouped = new Map<string, { ids: Set<number>; manual: number }>();
  for (const tag of evidence) {
    if (!photoMap.has(tag.photoId)) {
      continue;
    }
    const group = grouped.get(tag.name) ?? {
      ids: new Set<number>(),
      manual: 0,
    };
    group.ids.add(tag.photoId);
    group.manual += Number(tag.manual);
    grouped.set(tag.name, group);
  }
  const day = localSearchDay(now);
  const history = new Set(
    input.history.map((text) => text.trim().toLocaleLowerCase())
  );
  const candidates: StarterCandidate[] = [];
  const label = (name: string) =>
    input.language === "zh" ? name : (concepts.get(name)?.en ?? name);
  const hasTime = (
    ["dateFrom", "dateTo", "dateMonth", "dateHour"] as const
  ).some((key) => input.filters[key] !== undefined);
  const add = (names: string[], ids: number[], manual: number) => {
    if (ids.length < 2) {
      return;
    }
    const text = names
      .map(label)
      .join(input.language === "zh" ? "与" : " and ");
    if (history.has(text.toLocaleLowerCase())) {
      return;
    }
    const key = names.slice().sort().join("|");
    const interest =
      ids.reduce((sum, id) => sum + photoInterest(photoMap.get(id), now), 0) +
      input.history.reduce(
        (sum, query, index) =>
          sum +
          (names.some(
            (name) =>
              query
                .toLocaleLowerCase()
                .includes(label(name).toLocaleLowerCase()) ||
              query.includes(name)
          )
            ? (input.history.length - index) / Math.max(input.history.length, 1)
            : 0),
        0
      );
    const base = { key, text, topics: names, photoIds: ids };
    const score =
      Math.log1p(ids.length) +
      Math.log1p(manual) +
      (dayOrder(`${day}:${key}`) % 1000) / 1000;
    candidates.push({ ...base, source: "library", score });
    if (interest > 0) {
      candidates.push({
        ...base,
        source: "interest",
        score: score + Math.log1p(interest),
      });
    }
    const rediscovery = rediscoveryCandidate(
      { ...base, source: "library", score },
      photoMap,
      input.language,
      hasTime,
      now
    );
    if (rediscovery) {
      candidates.push(rediscovery);
    }
  };
  const themes = [...grouped.entries()]
    .sort((a, b) => b[1].ids.size + b[1].manual - (a[1].ids.size + a[1].manual))
    .slice(0, 16);
  for (const [name, group] of themes) {
    add([name], [...group.ids], group.manual);
  }
  combineThemes(themes, concepts, add);
  // Untagged libraries can still discover semantic themes using the existing vocabulary.
  if (themes.length < 4 && photos.length >= 2) {
    const probes = vocabulary.filter((item) =>
      ["scene", "animal", "object", "activity"].includes(item.category)
    );
    probes.sort(
      (a, b) => dayOrder(`${day}:${a.zh}`) - dayOrder(`${day}:${b.zh}`)
    );
    for (const probe of probes.slice(0, 8)) {
      if (!grouped.has(probe.zh)) {
        add(
          [probe.zh],
          photos.map((photo) => photo.id),
          0
        );
      }
    }
  }
  const ordered: StarterCandidate[] = [];
  for (const source of ["library", "interest", "rediscovery"] as const) {
    ordered.push(
      ...candidates
        .filter((candidate) => candidate.source === source)
        .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
        .slice(0, 16)
    );
  }
  return ordered;
}
