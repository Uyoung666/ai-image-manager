import fs from "node:fs";
import path from "node:path";
import { os } from "@orpc/server";
import { app, shell } from "electron";
import { getHttpServerPort } from "@/services/http-server";
import {
  checkForUpdatesManually,
  installUpdate,
} from "@/services/update-manager";
import { getUpdateState } from "@/services/update-state";
import { consumeUpdateWelcome as consumeUpdateWelcomeState } from "@/services/update-welcome-state";
import type { UpdateResult, UpdateStatus } from "@/types/update";

const STABLE_VERSION_RE = /^\d+\.\d+\.\d+$/;

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
  } catch {
    /* best-effort */
  }
  app.relaunch({
    execPath: process.execPath,
    args: process.argv.slice(1).filter((a) => !a.startsWith("--squirrel-")),
  });
  app.quit();
});

export const checkForUpdates = os.handler((): UpdateResult => {
  return checkForUpdatesManually();
});

export const getUpdateStatus = os.handler((): UpdateStatus => {
  return getUpdateState(app.getVersion());
});

export const installDownloadedUpdate = os.handler((): UpdateResult => {
  return installUpdate();
});

export const consumeUpdateWelcome = os.handler(() => {
  return consumeUpdateWelcomeState();
});

/**
 * 返回本地 HTTP 服务器当前监听的端口号。
 * 前端可通过此接口获取动态分配的端口，用于构建 HTTP 图片 URL。
 * 如果 HTTP 服务器尚未启动，返回 null。
 */
export const getHttpPort = os.handler(() => {
  return getHttpServerPort();
});

export const openReleasePage = os.handler(() => {
  const status = getUpdateState(app.getVersion());
  const target =
    status.version && STABLE_VERSION_RE.test(status.version)
      ? `https://github.com/Uyoung666/ai-image-manager/releases/tag/v${status.version}`
      : "https://github.com/Uyoung666/ai-image-manager/releases/latest";
  shell.openExternal(target);
  return { ok: true };
});
