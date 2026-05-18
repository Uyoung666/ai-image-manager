import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { os } from "@orpc/server";
import { app, BrowserWindow } from "electron";
import { z } from "zod";
import { registry } from "@/services/registry";
import {
  getAllSettings,
  getSetting,
  setSetting,
} from "@/services/settings-manager";
import {
  getDataPath,
  isDefaultDataPath,
  setCustomDataPath,
} from "@/utils/data-path";

const diagLog = (msg: string) => {
  try {
    const dir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "migrate.log"),
      `${new Date().toISOString()} ${msg}\n`,
      { flag: "a" }
    );
  } catch {
    /* best-effort */
  }
};

type MigrateProgress =
  | { phase: "start"; total: number }
  | { phase: "stopping-services" }
  | { phase: "copying"; dir: string; index: number; total: number }
  | { phase: "copied"; dir: string; index: number; total: number }
  | {
      phase: "skipped";
      dir: string;
      index: number;
      total: number;
      reason: string;
    }
  | {
      phase: "failed";
      dir: string;
      index: number;
      total: number;
      error: string;
    }
  | { phase: "done"; copied: number; errors: string[] };

const sendMigrateProgress = (payload: MigrateProgress) => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("data-path-migrate-progress", payload);
  }
};

export const getAppSetting = os
  .input(z.object({ key: z.string() }))
  .handler(async ({ input }) => {
    const value = getSetting(input.key);
    if (value === null) {
      return null;
    }
    return { key: input.key, value };
  });

export const setAppSetting = os
  .input(z.object({ key: z.string(), value: z.string() }))
  .handler(async ({ input }) => {
    setSetting(input.key, input.value);
    return { ok: true };
  });

export const getAllAppSettings = os
  .input(z.object({ prefix: z.string().optional() }))
  .handler(async ({ input }) => {
    const settings = getAllSettings(input.prefix);
    return { settings };
  });

export const getDataPathInfo = os.handler(() => {
  return {
    path: getDataPath(),
    isDefault: isDefaultDataPath(),
  };
});

export const setDataPath = os
  .input(z.object({ newPath: z.string().min(1) }))
  .handler(async ({ input }) => {
    diagLog("setDataPath: START");
    const oldPath = getDataPath();
    const { newPath } = input;
    diagLog(`setDataPath: old=${oldPath} new=${newPath}`);

    // Validate new path
    if (!fs.existsSync(newPath)) {
      try {
        diagLog("setDataPath: mkdir newPath");
        fs.mkdirSync(newPath, { recursive: true });
      } catch {
        return { ok: false, error: "无法创建目录" };
      }
    }

    // Check writable
    try {
      fs.accessSync(newPath, fs.constants.W_OK);
    } catch {
      return { ok: false, error: "目录不可写" };
    }

    // Same path
    if (path.resolve(oldPath) === path.resolve(newPath)) {
      return { ok: true, copied: 0 };
    }

    // Pre-check: refuse migration into a directory that already contains
    // data subdirectories, to avoid silently skipping files.
    const subDirs = ["data", "models", "thumbnails", "vectors"];
    for (const dir of subDirs) {
      const existing = path.join(newPath, dir);
      if (fs.existsSync(existing)) {
        diagLog(`setDataPath: ABORT — dst subdir exists: ${dir}`);
        return {
          ok: false,
          error: `目标目录下已有 "${dir}" 子目录，请选择一个空目录以避免数据覆盖`,
        };
      }
    }

    sendMigrateProgress({ phase: "start", total: subDirs.length });

    // Gracefully close all services to release file locks (DB, vector DB, etc.)
    diagLog("setDataPath: calling registry.stop()");
    sendMigrateProgress({ phase: "stopping-services" });
    try {
      await registry.stop();
      diagLog("setDataPath: registry.stop() OK");
    } catch (err) {
      diagLog(
        `setDataPath: registry.stop() FAILED: ${(err as Error)?.message}`
      );
      console.error(
        "[Settings] Failed to stop services before migration:",
        (err as Error)?.message
      );
      return { ok: false, error: "无法关闭后台服务，请重试" };
    }

    // Migrate data subdirectories from old to new (don't delete old data).
    // IMPORTANT: must be async — fs.cpSync blocks the Electron main process
    // event loop, and Windows kills the app as "Not Responding" when copying
    // hundreds of MB (e.g. the ~300 MB models directory).
    let copied = 0;
    const errors: string[] = [];
    for (let i = 0; i < subDirs.length; i++) {
      const dir = subDirs[i];
      const index = i + 1;
      const total = subDirs.length;
      const src = path.join(oldPath, dir);
      const dst = path.join(newPath, dir);
      let srcExists = false;
      try {
        srcExists = fs.existsSync(src);
      } catch {
        srcExists = false;
      }
      if (!srcExists) {
        diagLog(`setDataPath: skip ${dir} (src missing)`);
        sendMigrateProgress({
          phase: "skipped",
          dir,
          index,
          total,
          reason: "源目录不存在",
        });
        continue;
      }
      try {
        diagLog(`setDataPath: copying ${dir}…`);
        sendMigrateProgress({ phase: "copying", dir, index, total });
        await fsp.cp(src, dst, {
          recursive: true,
          force: false,
          errorOnExist: false,
        });
        copied++;
        diagLog(`setDataPath: copy ${dir} OK`);
        sendMigrateProgress({ phase: "copied", dir, index, total });
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        diagLog(`setDataPath: copy ${dir} FAILED: ${msg}`);
        console.error(`[Settings] Failed to copy ${dir}:`, msg);
        errors.push(`${dir}: ${msg}`);
        sendMigrateProgress({
          phase: "failed",
          dir,
          index,
          total,
          error: msg,
        });
      }
    }

    if (copied === 0 && errors.length > 0) {
      sendMigrateProgress({ phase: "done", copied, errors });
      // Try to bring services back up on the OLD path so the app stays usable.
      try {
        await registry.start();
      } catch (err) {
        diagLog(
          `setDataPath: rollback registry.start() FAILED: ${(err as Error)?.message}`
        );
      }
      return {
        ok: false,
        error: `文件迁移失败：${errors.join("; ")}`,
      };
    }

    diagLog("setDataPath: calling setCustomDataPath");
    setCustomDataPath(newPath);
    diagLog("setDataPath: DONE");
    console.log(
      `[Settings] Data path changed: ${oldPath} → ${newPath} (copied ${copied} dirs)`
    );

    // Clean up the old directory's subdirs to avoid disk bloat across repeated
    // migrations (each migration would otherwise leave a ~420MB orphan copy).
    // SAFETY: we only ever delete the four well-known subdirs we just copied,
    // and only if their copy succeeded — never the parent oldPath itself, never
    // any other files the user may have placed there.
    let cleaned = 0;
    const cleanupErrors: string[] = [];
    if (errors.length === 0) {
      for (const dir of subDirs) {
        const oldSub = path.join(oldPath, dir);
        let exists = false;
        try {
          exists = fs.existsSync(oldSub);
        } catch {
          exists = false;
        }
        if (!exists) continue;
        try {
          diagLog(`setDataPath: cleanup removing old ${oldSub}`);
          await fsp.rm(oldSub, { recursive: true, force: true });
          cleaned++;
          diagLog(`setDataPath: cleanup ${dir} OK`);
        } catch (err) {
          const msg = (err as Error)?.message ?? String(err);
          diagLog(`setDataPath: cleanup ${dir} FAILED: ${msg}`);
          cleanupErrors.push(`${dir}: ${msg}`);
        }
      }
      if (cleaned > 0) {
        console.log(
          `[Settings] Removed ${cleaned} old subdir(s) under ${oldPath}`
        );
      }
    } else {
      diagLog(
        "setDataPath: skip cleanup (errors during copy — preserving old data)"
      );
    }

    // Restart services in-place against the NEW path. This avoids relying on
    // app.relaunch() (broken in `npm run dev` because forge tears down the
    // Vite dev server when the main process exits, so the relaunched process
    // loads a dead URL → white screen). The renderer will reload() on receipt
    // of the "done" event and reconnect via a fresh oRPC port.
    diagLog("setDataPath: calling registry.start()");
    try {
      await registry.start();
      diagLog("setDataPath: registry.start() OK");
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      diagLog(`setDataPath: registry.start() FAILED: ${msg}`);
      console.error("[Settings] Failed to restart services:", msg);
      sendMigrateProgress({
        phase: "done",
        copied,
        errors: [...errors, `服务重启失败：${msg}`],
      });
      return {
        ok: false,
        error: `数据已迁移到新路径，但服务重启失败：${msg}。请手动重启应用。`,
      };
    }

    sendMigrateProgress({ phase: "done", copied, errors });
    return {
      ok: true,
      copied,
      cleaned,
      errors: errors.length > 0 ? errors : undefined,
      cleanupErrors: cleanupErrors.length > 0 ? cleanupErrors : undefined,
    };
  });
