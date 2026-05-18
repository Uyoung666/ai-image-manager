import fs from "node:fs";
import path from "node:path";
import { os } from "@orpc/server";
import { app } from "electron";

export const currentPlatform = os.handler(() => {
  return process.platform;
});

export const appVersion = os.handler(() => {
  return app.getVersion();
});

export const restartApp = os.handler(() => {
  try {
    const dir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "migrate.log"),
      `${new Date().toISOString()} restartApp: relaunch + quit\n`,
      { flag: "a" }
    );
  } catch { /* best-effort */ }
  app.relaunch({
    execPath: process.execPath,
    args: process.argv.slice(1).filter((a) => !a.startsWith("--squirrel-")),
  });
  app.quit();
});
