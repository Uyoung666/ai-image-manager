import type {
  PhotoSequence,
  PhotoSequenceDetail,
} from "@/types/photo-sequence";

export type GalleryReturnTarget =
  | { kind: "photo"; photoId: number }
  | { kind: "sequence"; sequenceId: number }
  | { kind: "sequence-member"; sequenceId: number; photoId: number };

export function resolveGalleryReturnTarget(
  target: GalleryReturnTarget | null,
  photos: readonly { id: number }[],
  sequences: readonly PhotoSequence[],
  details: readonly PhotoSequenceDetail[] = []
): GalleryReturnTarget | null {
  if (!target) {
    return null;
  }
  if (target.kind === "photo") {
    return photos.some((photo) => photo.id === target.photoId) ? target : null;
  }
  const sequence = sequences.find((item) => item.id === target.sequenceId);
  if (!sequence) {
    return null;
  }
  if (target.kind === "sequence") {
    return target;
  }
  const scopedIds = sequence.matchedPhotoIds ?? sequence.memberPhotoIds;
  const memberExists = scopedIds
    ? scopedIds.includes(target.photoId)
    : details.some(
        (detail) =>
          detail.id === target.sequenceId &&
          detail.members.some((photo) => photo.id === target.photoId)
      );
  return memberExists
    ? target
    : { kind: "sequence", sequenceId: target.sequenceId };
}

export function getGalleryReturnPresentation(
  target: GalleryReturnTarget | null,
  sequences: readonly PhotoSequence[],
  expanded: PhotoSequenceDetail | null | undefined,
  complete: PhotoSequenceDetail | null | undefined
) {
  if (!target || target.kind === "photo") {
    return {
      itemId: target?.photoId ?? null,
      memberId: null,
      frame: undefined,
    };
  }
  const sequence = sequences.find((item) => item.id === target.sequenceId);
  const photoId = target.kind === "sequence-member" ? target.photoId : null;
  const orderedIds =
    sequence?.memberPhotoIds ??
    (complete?.id === target.sequenceId
      ? complete.members.map((member) => member.id)
      : []);
  const index = photoId === null ? -1 : orderedIds.indexOf(photoId);
  const isExpanded = expanded?.id === target.sequenceId;
  return {
    itemId: isExpanded ? -target.sequenceId : (sequence?.photo.id ?? null),
    memberId:
      isExpanded && expanded.members.some((member) => member.id === photoId)
        ? photoId
        : null,
    frame: index < 0 ? undefined : index + 1,
  };
}

/** Reveal just the obscured edge. Coordinates are relative to the usable viewport. */
export function getReturnScrollTop({
  cardTop,
  cardHeight,
  scrollTop,
  clientHeight,
  topInset,
}: {
  cardTop: number;
  cardHeight: number;
  scrollTop: number;
  clientHeight: number;
  topInset: number;
}): number | null {
  const availableHeight = Math.max(
    1,
    clientHeight - (topInset > 0 ? topInset + 8 : 0)
  );
  if (
    cardTop >= scrollTop &&
    cardTop + cardHeight <= scrollTop + availableHeight
  ) {
    return null;
  }
  return Math.max(
    0,
    cardTop < scrollTop || cardHeight > availableHeight
      ? cardTop
      : cardTop + cardHeight - availableHeight
  );
}
