export interface PhotoGroupInput {
  fileDate?: number | null;
  id: number;
}

export interface PhotoGroupInputSnapshot {
  fileDate: number | null;
  id: number;
}

export interface PhotoGroupHeader {
  beforeIndex: number;
  label: string;
}

export function snapshotPhotoGroupInputs(
  photos: PhotoGroupInput[]
): PhotoGroupInputSnapshot[] {
  return photos.map((photo) => ({
    fileDate: photo.fileDate ?? null,
    id: photo.id,
  }));
}

export function hasMatchingPhotoGroupPrefix(
  snapshot: PhotoGroupInputSnapshot[],
  photos: PhotoGroupInput[]
): boolean {
  if (snapshot.length > photos.length) {
    return false;
  }
  for (let i = 0; i < snapshot.length; i++) {
    if (
      snapshot[i].id !== photos[i].id ||
      snapshot[i].fileDate !== (photos[i].fileDate ?? null)
    ) {
      return false;
    }
  }
  return true;
}

export function buildPhotoGroupHeaders(
  photos: PhotoGroupInput[],
  language: string,
  startIndex = 0,
  existingHeaders: PhotoGroupHeader[] = []
): PhotoGroupHeader[] {
  const headers = [...existingHeaders];
  let lastKey = "";
  const previousDate = photos[startIndex - 1]?.fileDate;
  if (previousDate) {
    const previous = new Date(previousDate);
    lastKey = `${previous.getFullYear()}-${previous.getMonth()}`;
  }
  const formatter = new Intl.DateTimeFormat(language, {
    month: "long",
    year: "numeric",
  });
  for (let index = startIndex; index < photos.length; index++) {
    const timestamp = photos[index].fileDate;
    if (!timestamp) {
      continue;
    }
    const date = new Date(timestamp);
    const key = `${date.getFullYear()}-${date.getMonth()}`;
    if (key === lastKey) {
      continue;
    }
    lastKey = key;
    headers.push({ beforeIndex: index, label: formatter.format(date) });
  }
  return headers;
}
