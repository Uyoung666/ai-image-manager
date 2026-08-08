import {
  appVersion,
  checkForUpdates,
  consumeUpdateWelcome,
  currentPlatform,
  getHttpPort,
  getUpdateProxy,
  getUpdateStatus,
  installDownloadedUpdate,
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
  consumeUpdateWelcome,
  getUpdateStatus,
  getHttpPort,
  installDownloadedUpdate,
  getUpdateProxy,
  setUpdateProxy,
  testProxy,
  openReleasePage,
};
