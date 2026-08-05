import { ipc } from "@/ipc/manager";
import type {
  GetWanderSessionInput,
  RecordWanderExposureInput,
  SaveWanderSessionToAlbumInput,
  WanderSettings,
} from "@/types/wander";
import { parseWanderSettings } from "@/types/wander";

const WANDER_SETTING_KEYS = {
  enabled: "wander.enabled",
  idleMinutes: "wander.idleMinutes",
  intervalSeconds: "wander.intervalSeconds",
  modes: "wander.modes",
} as const;

export const getWanderSession = (input: GetWanderSessionInput) =>
  ipc.client.wander.getWanderSession(input);

export const recordWanderExposure = (input: RecordWanderExposureInput) =>
  ipc.client.wander.recordWanderExposure(input);

export const saveWanderSessionToAlbum = (
  input: SaveWanderSessionToAlbumInput
) => ipc.client.wander.saveWanderSessionToAlbum(input);

export async function getWanderSettings(): Promise<WanderSettings> {
  const result = await ipc.client.settings.getAllAppSettings({
    prefix: "wander.",
  });
  return parseWanderSettings(result.settings);
}

export async function setWanderSettings(
  settings: WanderSettings
): Promise<void> {
  await Promise.all([
    ipc.client.settings.setAppSetting({
      key: WANDER_SETTING_KEYS.enabled,
      value: String(settings.enabled),
    }),
    ipc.client.settings.setAppSetting({
      key: WANDER_SETTING_KEYS.idleMinutes,
      value: String(settings.idleMinutes),
    }),
    ipc.client.settings.setAppSetting({
      key: WANDER_SETTING_KEYS.intervalSeconds,
      value: String(settings.intervalSeconds),
    }),
    ipc.client.settings.setAppSetting({
      key: WANDER_SETTING_KEYS.modes,
      value: JSON.stringify(settings.modes),
    }),
  ]);
}

export const wanderActions = {
  getSession: getWanderSession,
  getSettings: getWanderSettings,
  recordExposure: recordWanderExposure,
  saveToAlbum: saveWanderSessionToAlbum,
  setSettings: setWanderSettings,
};
