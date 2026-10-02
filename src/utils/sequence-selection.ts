import type { Photo } from "@/types/photo";
import type {
  PhotoSequence,
  PhotoSequenceDetail,
} from "@/types/photo-sequence";

/** Resolve only selected, in-scope members missing from the loaded photo pages. */
export async function resolveSequenceSelection(
  ids: number[],
  photos: Photo[],
  sequences: PhotoSequence[],
  loadDetail: (id: number) => Promise<PhotoSequenceDetail | null>
): Promise<Photo[]> {
  const byId = new Map(photos.map((photo) => [photo.id, photo]));
  const missing = new Set(ids.filter((id) => !byId.has(id)));
  const needed = sequences.filter((sequence) =>
    (sequence.matchedPhotoIds ?? sequence.memberPhotoIds ?? []).some((id) =>
      missing.has(id)
    )
  );
  const details = await Promise.all(
    needed.map((sequence) => loadDetail(sequence.id))
  );
  for (let index = 0; index < needed.length; index++) {
    const allowed = new Set(
      needed[index].matchedPhotoIds ?? needed[index].memberPhotoIds ?? []
    );
    for (const photo of details[index]?.members ?? []) {
      if (missing.has(photo.id) && allowed.has(photo.id)) {
        byId.set(photo.id, photo);
      }
    }
  }
  return ids.map((id) => {
    const photo = byId.get(id);
    if (!photo) {
      throw new Error("Selected photo is unavailable in the current scope");
    }
    return photo;
  });
}
