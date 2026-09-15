// A revision in the search fingerprint invalidates both stored cursors and
// cursors created by requests that were still running during a tag mutation.
let revision = 0;

export function getTagSearchRevision(): number {
  return revision;
}

export function invalidateTagSearch(): void {
  revision++;
}
