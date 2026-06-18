import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import Store from "electron-store";

let resolvedDataPath: string | null = null;

let configStore: Store<{ dataPath: string }> | null = null;

function getConfigStore(): Store<{ dataPath: string }> {
  if (!configStore) {
    configStore = new Store({
      name: "app-config",
      defaults: { dataPath: "" },
    });
  }
  return configStore;
}

function readConfigFileDirectly(): string {
  try {
    const filePath = path.join(app.getPath("userData"), "app-config.json");
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      return (parsed as any).dataPath || "";
    }
  } catch {
    // ignore
  }
  return "";
}

export function initDataPath(): string {
  if (resolvedDataPath) {
    return resolvedDataPath;
  }

  // Read config file directly — more reliable than electron-store
  // during early startup (electron-store via conf may return stale defaults)
  const directValue = readConfigFileDirectly();
  const storeValue = getConfigStore().get("dataPath", "");
  const customPath = directValue || storeValue;
  const defaultPath = app.getPath("userData");

  if (customPath) {
    if (fs.existsSync(customPath)) {
      resolvedDataPath = customPath;
    } else {
      resolvedDataPath = defaultPath;
    }
  } else {
    resolvedDataPath = defaultPath;
  }

  if (!fs.existsSync(resolvedDataPath)) {
    fs.mkdirSync(resolvedDataPath, { recursive: true });
  }

  return resolvedDataPath;
}

export function getDataPath(): string {
  if (!resolvedDataPath) {
    return initDataPath();
  }
  return resolvedDataPath;
}

export function setCustomDataPath(newPath: string): void {
  getConfigStore().set("dataPath", newPath);
  resolvedDataPath = newPath;
}

export function isDefaultDataPath(): boolean {
  return !getConfigStore().get("dataPath", "");
}
