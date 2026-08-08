import {
  appVersion,
  checkForUpdates,
  consumeUpdateWelcome,
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
  consumeUpdateWelcome,
  getUpdateStatus,
  getHttpPort,
  getUpdateProxy,
  setUpdateProxy,
  testProxy,
  openReleasePage,
};
