import fs from "node:fs";
import path from "node:path";
import { os } from "@orpc/server";
import { app, autoUpdater, net, session, shell } from "electron";
import Store from "electron-store";
import { z } from "zod";
import { getHttpServerPort } from "@/services/http-server";
import { getUpdateState } from "@/services/update-state";
import {
  consumeUpdateWelcome as consumeUpdateWelcomeState,
} from "@/services/update-welcome-state";

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

export const checkForUpdates = os.handler(() => {
  if (!app.isPackaged) {
    return { ok: false, error: "DEV_MODE" };
  }
  try {
    autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: (err as Error)?.message || String(err) };
  }
});

export const getUpdateStatus = os.handler(() => {
  return getUpdateState();
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

// ── Update proxy ─────────────────────────────────────────────────────
let __updateConfigStore: Store<{ proxy: string }> | null = null;
function getStore() {
  if (!__updateConfigStore) {
    __updateConfigStore = new Store<{ proxy: string }>({
      name: "update-config",
      defaults: { proxy: "" },
    });
  }
  return __updateConfigStore;
}

export const getUpdateProxy = os.handler(() => {
  return { proxy: getStore().get("proxy", "") };
});

export const setUpdateProxy = os
  .input(z.object({ proxy: z.string() }))
  .handler(async ({ input }) => {
    getStore().set("proxy", input.proxy);
    if (input.proxy) {
      await session.defaultSession.setProxy({ proxyRules: input.proxy });
    } else {
      await session.defaultSession.setProxy({});
    }
    return { ok: true };
  });

export const testProxy = os.handler(async () => {
  const start = Date.now();
  // Step 1: HEAD to measure latency
  try {
    const headRes = await net.fetch("https://github.com", {
      method: "HEAD",
    });
    const latency = Date.now() - start;

    // Step 2: GET a small page to measure throughput
    const speedStart = Date.now();
    const bodyRes = await net.fetch("https://github.com", { method: "GET" });
    const buf = await bodyRes.arrayBuffer();
    const elapsed = (Date.now() - speedStart) / 1000; // seconds
    const bytes = buf.byteLength;
    const bytesPerSecond = elapsed > 0 ? bytes / elapsed : 0;

    return {
      ok: true,
      status: headRes.status,
      latency,
      bytes,
      bytesPerSecond: Math.round(bytesPerSecond),
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: (err as Error)?.message || String(err),
      latency: Date.now() - start,
    };
  }
});

export const openReleasePage = os.handler(() => {
  shell.openExternal(
    "https://github.com/Uyoung666/ai-image-manager/releases/latest"
  );
  return { ok: true };
});
