import {
  appVersion,
  checkForUpdates,
  consumeUpdateWelcome,
  currentPlatform,
  getHttpPort,
  getUpdateStatus,
  installDownloadedUpdate,
  openReleasePage,
  restartApp,
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
  openReleasePage,
};
