import { os } from "@orpc/server";
import { app } from "electron";

export const currentPlatform = os.handler(() => {
  return process.platform;
});

export const appVersion = os.handler(() => {
  return app.getVersion();
});
