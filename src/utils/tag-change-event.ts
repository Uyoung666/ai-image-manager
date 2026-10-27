export interface TagsChangedDetail {
  photoIds?: number[];
  source?: "detail" | "batch" | "undo";
}

export function notifyTagsChanged(detail?: TagsChangedDetail): void {
  window.dispatchEvent(
    new CustomEvent<TagsChangedDetail>("tags-changed", { detail })
  );
}

export function getTagsChangedDetail(
  event: Event
): TagsChangedDetail | undefined {
  return (event as CustomEvent<TagsChangedDetail>).detail;
}
