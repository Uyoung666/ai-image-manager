import { scanFolder, getFolders, deleteFolder, listPhotos, getPhotoDetail, getPhotoExif } from "./handlers/listing";
import { deletePhoto, deletePhotos, cleanupOrphanPhotos, renamePhotos, convertPhotos, clearThumbCache } from "./handlers/mutations";
import { searchByText, searchByImage, searchCompound } from "./handlers/search";
import { startAiIndexing, stopAiIndexing, getAiProgress, getAiStatus, getAiHealth } from "./handlers/ai";
import { suggestTags, getTags, getPhotoTags, addTag, setPhotoTag, removePhotoTag, confirmPhotoTag, deleteTag } from "./handlers/tags";
import { getStats, findDuplicates, dismissDuplicate, getDuplicateStats } from "./handlers/stats";
import { exportPhotos, getWatermarkSettings, setWatermarkSettings } from "./handlers/export";

export const photos = {
  addTag,
  cleanupOrphanPhotos,
  clearThumbCache,
  confirmPhotoTag,
  convertPhotos,
  deleteFolder,
  deletePhoto,
  deletePhotos,
  deleteTag,
  dismissDuplicate,
  exportPhotos,
  findDuplicates,
  getAiHealth,
  getAiProgress,
  getAiStatus,
  getDuplicateStats,
  getFolders,
  getPhotoDetail,
  getPhotoExif,
  getPhotoTags,
  getStats,
  getTags,
  getWatermarkSettings,
  listPhotos,
  removePhotoTag,
  renamePhotos,
  scanFolder,
  searchByImage,
  searchByText,
  searchCompound,
  setPhotoTag,
  setWatermarkSettings,
  startAiIndexing,
  stopAiIndexing,
  suggestTags,
};
