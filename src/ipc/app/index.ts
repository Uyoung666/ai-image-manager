import {
  appVersion,
  checkForUpdates,
  consumeUpdateWelcome,
  currentPlatform,
  downloadFullUpdate,
  getHttpPort,
  getUpdateStatus,
  installDownloadedUpdate,
  openReleasePage,
  restartApp,
  resumeUpdate,
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
  resumeUpdate,
  downloadFullUpdate,
};
