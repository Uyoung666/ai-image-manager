import { ipc } from "@/ipc/manager";
import type { Photo } from "@/types/photo";
import {
  isWindowedGalleryPhoto,
  updateGalleryFavorites,
} from "@/utils/gallery-data-source";

export function withPhotoFavorite<T extends Photo>(
  photo: T,
  favorite: boolean
): T {
  return isWindowedGalleryPhoto(photo)
    ? photo
    : { ...photo, isFavorite: favorite };
}

export const photoFavoriteActions = {
  set: async (input: { ids: number[]; favorite: boolean }) => {
    const result = await ipc.client.photos.toggleFavorite(input);
    updateGalleryFavorites(input.ids, input.favorite);
    return result;
  },
};

export const setPhotoFavorites = (ids: number[], favorite: boolean) =>
  photoFavoriteActions.set({ ids, favorite });
