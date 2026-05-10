import {
  deleteFolder,
  getAiProgress,
  getFolders,
  getPhotoDetail,
  getPhotoExif,
  getStats,
  listPhotos,
  scanFolder,
  searchByImage,
  searchByText,
  startAiIndexing,
} from "./handlers";

export const photos = {
  scanFolder,
  listPhotos,
  getPhotoDetail,
  getPhotoExif,
  getStats,
  searchByText,
  searchByImage,
  startAiIndexing,
  getAiProgress,
  getFolders,
  deleteFolder,
};
