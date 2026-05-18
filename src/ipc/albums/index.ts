import {
  addPhotosToAlbum,
  createAlbum,
  deleteAlbum,
  evaluateSmartAlbumHandler,
  getAlbum,
  listAlbums,
  removePhotosFromAlbum,
  reorderAlbumPhotos,
  updateAlbum,
  validateSmartAlbumRules,
} from "./handlers";

export const albums = {
  addPhotosToAlbum,
  createAlbum,
  deleteAlbum,
  evaluateSmartAlbum: evaluateSmartAlbumHandler,
  getAlbum,
  listAlbums,
  removePhotosFromAlbum,
  reorderAlbumPhotos,
  updateAlbum,
  validateSmartAlbumRules,
};
