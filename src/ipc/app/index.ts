import {
  appVersion,
  checkForUpdates,
  currentPlatform,
  getHttpPort,
  getUpdateProxy,
  getUpdateStatus,
  openReleasePage,
  restartApp,
  setUpdateProxy,
  testProxy,
} from "./handlers";

export const app = {
  currentPlatform,
  appVersion,
  restartApp,
  checkForUpdates,
  getUpdateStatus,
  getHttpPort,
  getUpdateProxy,
  setUpdateProxy,
  testProxy,
  openReleasePage,
};
