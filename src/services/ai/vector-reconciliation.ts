export interface VectorReconciliationPlan {
  duplicateIds: number[];
  orphanIds: number[];
}

export function getUnreconciledVectorIds(
  targetIds: Iterable<number>,
  remainingIds: Iterable<number>
): number[] {
  const remaining = new Set(remainingIds);
  return [...new Set(targetIds)].filter((photoId) => remaining.has(photoId));
}

export function planVectorReconciliation(
  vectorPhotoIds: number[],
  validPhotoIds: Iterable<number>,
  forcedOrphanIds: Iterable<number> = []
): VectorReconciliationPlan {
  const validIds = new Set(validPhotoIds);
  const forcedOrphans = new Set(forcedOrphanIds);
  const counts = new Map<number, number>();
  const orphanIds = new Set<number>();

  for (const rawPhotoId of vectorPhotoIds) {
    const photoId = Number(rawPhotoId);
    if (!(Number.isInteger(photoId) && photoId > 0)) {
      continue;
    }
    if (!(validIds.has(photoId) && !forcedOrphans.has(photoId))) {
      orphanIds.add(photoId);
      continue;
    }
    counts.set(photoId, (counts.get(photoId) ?? 0) + 1);
  }

  return {
    duplicateIds: [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([photoId]) => photoId),
    orphanIds: [...orphanIds],
  };
}
