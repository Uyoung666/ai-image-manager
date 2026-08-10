export interface FaceRepresentativeMember {
  confidence: number | null;
  photoId: number;
  vectorId: number;
}

export interface CurrentFaceRepresentative {
  photoId: number | null;
  vectorId: string | null;
}

function compareRepresentativeMembers(
  a: FaceRepresentativeMember,
  b: FaceRepresentativeMember
): number {
  const confidenceA = Number.isFinite(a.confidence ?? Number.NaN)
    ? (a.confidence as number)
    : Number.NEGATIVE_INFINITY;
  const confidenceB = Number.isFinite(b.confidence ?? Number.NaN)
    ? (b.confidence as number)
    : Number.NEGATIVE_INFINITY;
  return confidenceB - confidenceA || a.vectorId - b.vectorId;
}

/**
 * Keep a valid current representative stable. If it is gone, prefer another
 * face from the same manually selected photo, then use the best remaining
 * member with a deterministic vector-id tie-breaker.
 */
export function selectFaceRepresentative(
  members: readonly FaceRepresentativeMember[],
  current: CurrentFaceRepresentative
): FaceRepresentativeMember | null {
  if (members.length === 0) {
    return null;
  }

  const currentVectorId = current.vectorId
    ? Number.parseInt(current.vectorId, 10)
    : Number.NaN;
  if (Number.isFinite(currentVectorId)) {
    const currentMember = members.find(
      (member) => member.vectorId === currentVectorId
    );
    if (currentMember) {
      return currentMember;
    }
  }

  if (current.photoId !== null) {
    const samePhoto = members
      .filter((member) => member.photoId === current.photoId)
      .sort(compareRepresentativeMembers);
    if (samePhoto.length > 0) {
      return samePhoto[0];
    }
  }

  return [...members].sort(compareRepresentativeMembers)[0];
}
