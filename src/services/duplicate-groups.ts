export interface DuplicatePhoto {
  createdAt: number;
  fileDate: number | null;
  filename: string;
  fileSize: number | null;
  height: number | null;
  id: number;
  path: string;
  thumbnailPath: string | null;
  width: number | null;
}

export interface DuplicatePairRecord {
  clipSimilarity: number | null;
  distance: number;
  matchType: "exact" | "phash" | "clip_confirmed";
  pairId: number;
  photoA: DuplicatePhoto;
  photoB: DuplicatePhoto;
  status: "pending" | "confirmed" | "dismissed";
}

export interface DuplicateGroup {
  estimatedReclaimBytes: number;
  groupKey: string;
  matchType: "exact" | "similar";
  pairIds: number[];
  photos: DuplicatePhoto[];
  recommendedKeepId: number;
  status: "active" | "dismissed";
}

export interface DuplicateRelationRef {
  id: number;
  photoAId: number;
  photoBId: number;
}

export function validateDuplicateCleanupGroup(
  relations: DuplicateRelationRef[],
  request: {
    deletePhotoIds: number[];
    keepPhotoId: number;
    pairIds: number[];
  }
): number[] {
  const pairIds = [...new Set(request.pairIds)];
  if (relations.length !== pairIds.length) {
    throw new Error("Duplicate group is stale; rescan before cleaning");
  }
  const relatedPhotoIds = new Set<number>();
  const adjacency = new Map<number, number[]>();
  for (const relation of relations) {
    relatedPhotoIds.add(relation.photoAId);
    relatedPhotoIds.add(relation.photoBId);
    adjacency.set(relation.photoAId, [
      ...(adjacency.get(relation.photoAId) ?? []),
      relation.photoBId,
    ]);
    adjacency.set(relation.photoBId, [
      ...(adjacency.get(relation.photoBId) ?? []),
      relation.photoAId,
    ]);
  }
  if (!relatedPhotoIds.has(request.keepPhotoId)) {
    throw new Error("Keeper does not belong to the duplicate group");
  }
  const connected = new Set<number>();
  const queue = [request.keepPhotoId];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || connected.has(current)) {
      continue;
    }
    connected.add(current);
    queue.push(...(adjacency.get(current) ?? []));
  }
  if (connected.size !== relatedPhotoIds.size) {
    throw new Error("Duplicate relationships do not form one group");
  }
  const deletePhotoIds = [...new Set(request.deletePhotoIds)];
  if (
    deletePhotoIds.includes(request.keepPhotoId) ||
    deletePhotoIds.some((id) => !relatedPhotoIds.has(id)) ||
    deletePhotoIds.length >= relatedPhotoIds.size
  ) {
    throw new Error("A duplicate group must retain at least one photo");
  }
  return deletePhotoIds;
}

function compareKeeperCandidates(a: DuplicatePhoto, b: DuplicatePhoto): number {
  const aPixels = (a.width ?? 0) * (a.height ?? 0);
  const bPixels = (b.width ?? 0) * (b.height ?? 0);
  if (aPixels !== bPixels) {
    return bPixels - aPixels;
  }
  if ((a.fileSize ?? 0) !== (b.fileSize ?? 0)) {
    return (b.fileSize ?? 0) - (a.fileSize ?? 0);
  }
  if ((a.fileDate ?? a.createdAt) !== (b.fileDate ?? b.createdAt)) {
    return (a.fileDate ?? a.createdAt) - (b.fileDate ?? b.createdAt);
  }
  return a.id - b.id;
}

export function recommendDuplicateKeeper(photos: DuplicatePhoto[]): number {
  if (photos.length === 0) {
    throw new Error("Cannot recommend a keeper for an empty duplicate group");
  }
  return [...photos].sort(compareKeeperCandidates)[0].id;
}

/**
 * Converts the persisted pair graph into disjoint connected components. A photo
 * therefore appears in at most one group, even when several detection methods
 * produced overlapping edges.
 */
export function groupDuplicatePairs(
  pairs: DuplicatePairRecord[]
): DuplicateGroup[] {
  const parent = new Map<number, number>();

  function find(id: number): number {
    const current = parent.get(id);
    if (current === undefined) {
      parent.set(id, id);
      return id;
    }
    if (current === id) {
      return id;
    }
    const root = find(current);
    parent.set(id, root);
    return root;
  }

  function union(a: number, b: number): void {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      parent.set(Math.max(rootA, rootB), Math.min(rootA, rootB));
    }
  }

  const uniquePairs = new Map<number, DuplicatePairRecord>();
  for (const pair of pairs) {
    if (pair.photoA.id === pair.photoB.id) {
      continue;
    }
    uniquePairs.set(pair.pairId, pair);
    union(pair.photoA.id, pair.photoB.id);
  }

  const components = new Map<number, DuplicatePairRecord[]>();
  for (const pair of uniquePairs.values()) {
    const root = find(pair.photoA.id);
    const component = components.get(root);
    if (component) {
      component.push(pair);
    } else {
      components.set(root, [pair]);
    }
  }

  return [...components.values()]
    .map((component): DuplicateGroup => {
      const photoMap = new Map<number, DuplicatePhoto>();
      for (const pair of component) {
        photoMap.set(pair.photoA.id, pair.photoA);
        photoMap.set(pair.photoB.id, pair.photoB);
      }
      const photos = [...photoMap.values()].sort((a, b) => a.id - b.id);
      const recommendedKeepId = recommendDuplicateKeeper(photos);
      const matchType = component.every((pair) => pair.matchType === "exact")
        ? "exact"
        : "similar";
      const status = component.every((pair) => pair.status === "dismissed")
        ? "dismissed"
        : "active";
      const estimatedReclaimBytes = photos.reduce(
        (total, photo) =>
          photo.id === recommendedKeepId
            ? total
            : total + (photo.fileSize ?? 0),
        0
      );
      const pairIds = component
        .map((pair) => pair.pairId)
        .sort((a, b) => a - b);

      return {
        estimatedReclaimBytes,
        groupKey: `${matchType}:${photos.map((photo) => photo.id).join("-")}`,
        matchType,
        pairIds,
        photos,
        recommendedKeepId,
        status,
      };
    })
    .sort((a, b) => {
      if (a.status !== b.status) {
        return a.status === "active" ? -1 : 1;
      }
      if (a.matchType !== b.matchType) {
        return a.matchType === "exact" ? -1 : 1;
      }
      return a.groupKey.localeCompare(b.groupKey);
    });
}
