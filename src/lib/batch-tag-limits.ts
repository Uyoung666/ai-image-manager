// Bound synchronous SQLite work by photo/tag pairs, including already owned tags.
export const MAX_BATCH_TAG_RELATIONS = 1000;
export function batchTagPhotoLimit(tagCount: number) {
  return Math.max(
    1,
    Math.floor(MAX_BATCH_TAG_RELATIONS / Math.max(1, tagCount))
  );
}
