import {
  appVersion,
  checkForUpdates,
  currentPlatform,
  getHttpPort,
  getUpdateStatus,
  restartApp,
} from "./handlers";

export const app = {
  currentPlatform,
  appVersion,
  restartApp,
  checkForUpdates,
  getUpdateStatus,
  getHttpPort,
};
