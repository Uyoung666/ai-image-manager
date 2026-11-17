import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import Store from "electron-store";

let resolvedDataPath: string | null = null;

interface ProfileConfig {
  dataPath: string;
  onboardingCompleted?: boolean;
}

let configStore: Store<ProfileConfig> | null = null;

function getConfigStore(): Store<ProfileConfig> {
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
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "dataPath" in parsed &&
        typeof parsed.dataPath === "string"
      ) {
        return parsed.dataPath;
      }
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

export function setRuntimeDataPath(newPath: string): void {
  resolvedDataPath = newPath;
}

export function isProfileOnboardingComplete(): boolean {
  return getConfigStore().get("onboardingCompleted", false);
}

export function persistDataPath(
  newPath: string,
  onboardingCompleted: boolean
): void {
  const defaultPath = app.getPath("userData");
  getConfigStore().set({
    dataPath: path.relative(defaultPath, newPath) === "" ? "" : newPath,
    ...(onboardingCompleted ? { onboardingCompleted } : {}),
  });
}

export function isDefaultDataPath(): boolean {
  return path.relative(getDataPath(), app.getPath("userData")) === "";
}
