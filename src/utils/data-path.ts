import fs from "node:fs";
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

export function initDataPath(): string {
  if (resolvedDataPath) {
    return resolvedDataPath;
  }

  const customPath = getConfigStore().get("dataPath", "");
  if (customPath) {
    resolvedDataPath = customPath;
  } else {
    resolvedDataPath = app.getPath("userData");
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
