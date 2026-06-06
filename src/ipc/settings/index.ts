import {
  checkMirrorHealth,
  getAllAppSettings,
  getAppSetting,
  getDataPathInfo,
  getGpuSettings,
  getMirrorSettings,
  setAppSetting,
  setDataPath,
  setGpuSettings,
  setMirrorSettings,
} from "./handlers";

export const settings = {
  getAllAppSettings,
  getAppSetting,
  setAppSetting,
  getDataPathInfo,
  setDataPath,
  getGpuSettings,
  getMirrorSettings,
  setGpuSettings,
  setMirrorSettings,
  checkMirrorHealth,
};
