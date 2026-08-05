export type WanderContentMode = "timeCapsule" | "theme" | "rediscovery";

export type WanderMode = "auto" | WanderContentMode;

export type WanderExposureSource = "lightbox" | "wander";

export interface WanderPhoto {
  fileDate: number | null;
  filename: string;
  height: number;
  id: number;
  isFavorite: boolean;
  isIndexed: boolean;
  path: string;
  thumbnailPath: string | null;
  width: number;
}

export interface WanderSession {
  mode: WanderContentMode;
  photos: WanderPhoto[];
  subtitleKey?: string;
  subtitleParams?: Record<string, number | string>;
  titleKey: string;
  titleParams?: Record<string, number | string>;
}

export interface WanderSettings {
  enabled: boolean;
  idleMinutes: 10 | 15 | 30;
  intervalSeconds: 3 | 5 | 10;
  modes: WanderContentMode[];
}

export const DEFAULT_WANDER_SETTINGS: WanderSettings = {
  enabled: false,
  idleMinutes: 15,
  intervalSeconds: 5,
  modes: ["timeCapsule", "theme", "rediscovery"],
};

const WANDER_CONTENT_MODES: WanderContentMode[] = [
  "timeCapsule",
  "theme",
  "rediscovery",
];

/** Parse persisted settings defensively so corrupt/legacy values stay harmless. */
export function parseWanderSettings(
  rows: Array<{ key: string; value: string }>
): WanderSettings {
  const values = new Map(rows.map(({ key, value }) => [key, value]));
  const choice = <T extends number>(
    key: string,
    choices: readonly T[],
    fallback: T
  ): T => {
    const parsed = Number(values.get(key));
    return choices.includes(parsed as T) ? (parsed as T) : fallback;
  };
  let modes = [...DEFAULT_WANDER_SETTINGS.modes];
  try {
    const parsed = JSON.parse(values.get("wander.modes") ?? "null");
    if (Array.isArray(parsed)) {
      const valid = [...new Set(parsed)].filter(
        (mode): mode is WanderContentMode =>
          typeof mode === "string" &&
          WANDER_CONTENT_MODES.includes(mode as WanderContentMode)
      );
      if (valid.length > 0) {
        modes = valid;
      }
    }
  } catch {
    // Keep defaults for malformed persisted JSON.
  }
  const enabled = values.get("wander.enabled");
  let parsedEnabled = DEFAULT_WANDER_SETTINGS.enabled;
  if (enabled === "true") {
    parsedEnabled = true;
  } else if (enabled === "false") {
    parsedEnabled = false;
  }
  return {
    enabled: parsedEnabled,
    idleMinutes: choice(
      "wander.idleMinutes",
      [10, 15, 30] as const,
      DEFAULT_WANDER_SETTINGS.idleMinutes
    ),
    intervalSeconds: choice(
      "wander.intervalSeconds",
      [3, 5, 10] as const,
      DEFAULT_WANDER_SETTINGS.intervalSeconds
    ),
    modes,
  };
}

export interface GetWanderSessionInput {
  allowedModes?: WanderContentMode[];
  excludeMode?: WanderContentMode;
  limit?: number;
  mode: WanderMode;
}

export interface RecordWanderExposureInput {
  photoId: number;
  source: WanderExposureSource;
}

export interface SaveWanderSessionToAlbumInput {
  photoIds: number[];
  title: string;
}
