import {
  appVersion,
  checkForUpdates,
  currentPlatform,
  getUpdateStatus,
  restartApp,
} from "./handlers";

export const app = {
  currentPlatform,
  appVersion,
  restartApp,
  checkForUpdates,
  getUpdateStatus,
};
