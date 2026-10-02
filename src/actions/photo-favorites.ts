import { ipc } from "@/ipc/manager";

export const setPhotoFavorites = (ids: number[], favorite: boolean) =>
  ipc.client.photos.toggleFavorite({ ids, favorite });
