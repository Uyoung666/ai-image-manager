import { app } from "electron";
import Store from "electron-store";
import { hasChangelog } from "@/content/changelogs";
import { decideUpdateWelcomeVersion } from "./update-welcome-decision";

interface UpdateWelcomeStore {
  lastLaunchedVersion?: string;
}

let store: Store<UpdateWelcomeStore> | null = null;

function getStore(): Store<UpdateWelcomeStore> {
  if (!store) {
    store = new Store<UpdateWelcomeStore>({
      name: "update-welcome",
      defaults: {},
    });
  }
  return store;
}

export function consumeUpdateWelcome(): { version: string | null } {
  const currentVersion = app.getVersion();
  const skip = process.env.CI === "e2e" || process.argv.includes("--e2e");
  if (!app.isPackaged || skip) {
    return { version: null };
  }

  const updateStore = getStore();
  const decision = decideUpdateWelcomeVersion({
    currentVersion,
    hasChangelog: hasChangelog(currentVersion),
    isPackaged: app.isPackaged,
    lastLaunchedVersion: updateStore.get("lastLaunchedVersion"),
    skip: false,
  });

  updateStore.set("lastLaunchedVersion", decision.nextLaunchedVersion);
  return { version: decision.version };
}
