import {
  checkGpuCapability,
  checkMirrorHealth,
  getAllAppSettings,
  getAppSetting,
  getDataPathInfo,
  getGpuSettings,
  getMirrorSettings,
  markGpuPromptShown,
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
  checkGpuCapability,
  markGpuPromptShown,
};
