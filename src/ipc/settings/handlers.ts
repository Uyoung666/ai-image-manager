import { os } from "@orpc/server";
import { eq, sql } from "drizzle-orm";
import { app, BrowserWindow, dialog } from "electron";
import { z } from "zod";
import { getDatabase } from "@/db";
import { duplicateCleanupPlans, duplicateReviewGroups } from "@/db/schema";
import {
  getDuplicateSensitivityConfig,
  parseDuplicateSensitivity,
} from "@/services/duplicate-sensitivity";
import { changeLibraryDirectory } from "@/services/library-directory";
import { notifySequencesChanged } from "@/services/photo-sequences";
import { refreshSequenceSuggestions } from "@/services/sequence-suggestions";
import {
  getAllSettings,
  getSetting,
  setSetting,
} from "@/services/settings-manager";
import { parseAccentColor } from "@/types/accent-color";
import {
  APP_PREFERENCE_DEFAULTS,
  APP_PREFERENCE_KEYS,
  type AppPreferences,
  parseBooleanPreference,
  parseCloseBehavior,
} from "@/types/app-preferences";
import {
  parseSearchHistoryPreferences,
  SEARCH_HISTORY_PREFERENCES_KEY,
  SearchHistoryPreferencesSchema,
} from "@/types/search-history";
import { normalizeSequenceDetectionSettings } from "@/types/sequence-detection-settings";
import {
  getDataPath,
  isDefaultDataPath,
  isProfileOnboardingComplete,
} from "@/utils/data-path";

export const getAppSetting = os
  .input(z.object({ key: z.string() }))
  .handler(({ input }) => {
    if (input.key === "onboarding.completed" && isProfileOnboardingComplete()) {
      return { key: input.key, value: "true" };
    }
    const value = getSetting(input.key);
    if (value === null) {
      return null;
    }
    return { key: input.key, value };
  });

export const getSearchHistoryPreferences = os
  .input(z.object({ legacyHistory: z.boolean() }).optional())
  .handler(({ input }) => {
    const saved = getSetting(SEARCH_HISTORY_PREFERENCES_KEY);
    const preferences = parseSearchHistoryPreferences(saved);
    if (saved === null && input?.legacyHistory) {
      preferences.limit = 20;
      setSetting(SEARCH_HISTORY_PREFERENCES_KEY, JSON.stringify(preferences));
    }
    return preferences;
  });

export const setSearchHistoryPreferences = os
  .input(SearchHistoryPreferencesSchema)
  .handler(({ input }) => {
    setSetting(SEARCH_HISTORY_PREFERENCES_KEY, JSON.stringify(input));
    return { ok: true };
  });

export const getDuplicateSettings = os.handler(() => {
  const preset = parseDuplicateSensitivity(
    getSetting("duplicates.sensitivity")
  );
  return {
    ...getDuplicateSensitivityConfig(preset),
    revision: getSetting("duplicates.settingsRevision") ?? "0",
  };
});

export const updateDuplicateSettings = os
  .input(
    z.object({
      expectedRevision: z.string().optional(),
      preset: z.enum(["strict", "standard", "loose"]),
    })
  )
  .handler(({ input }) => {
    const currentRevision = getSetting("duplicates.settingsRevision") ?? "0";
    if (input.expectedRevision && input.expectedRevision !== currentRevision) {
      throw new Error("Duplicate detection settings are stale; refresh first");
    }
    const parsedRevision = Number.parseInt(currentRevision, 10);
    const nextRevision = String(
      Number.isSafeInteger(parsedRevision) && parsedRevision >= 0
        ? parsedRevision + 1
        : 1
    );
    setSetting("duplicates.sensitivity", input.preset);
    setSetting("duplicates.settingsRevision", nextRevision);
    const db = getDatabase();
    db.transaction(() => {
      db.update(duplicateCleanupPlans)
        .set({ status: "STALE", updatedAt: Date.now() })
        .where(eq(duplicateCleanupPlans.status, "READY"))
        .run();
      db.update(duplicateReviewGroups)
        .set({
          complete: false,
          needsReview: true,
          reviewRevision: sql`${duplicateReviewGroups.reviewRevision} + 1`,
          updatedAt: Date.now(),
        })
        .where(eq(duplicateReviewGroups.ignoreState, "ACTIVE"))
        .run();
    });
    return {
      ...getDuplicateSensitivityConfig(input.preset),
      revision: nextRevision,
    };
  });

export const setAppSetting = os
  .input(z.object({ key: z.string(), value: z.string() }))
  .handler(({ input }) => {
    if (input.key === "sequence.detection.settings") {
      const normalized = normalizeSequenceDetectionSettings(
        JSON.parse(input.value)
      );
      getDatabase().transaction(() => {
        setSetting(input.key, JSON.stringify(normalized));
        refreshSequenceSuggestions();
      });
      notifySequencesChanged(undefined, "settings");
    } else {
      setSetting(input.key, input.value);
    }
    return { ok: true };
  });

export const getAllAppSettings = os
  .input(z.object({ prefix: z.string().optional() }))
  .handler(({ input }) => {
    const settings = getAllSettings(input.prefix);
    return { settings };
  });

export const getAppPreferences = os.handler(
  (): AppPreferences => ({
    accentColor: parseAccentColor(getSetting(APP_PREFERENCE_KEYS.accentColor)),
    closeBehavior: parseCloseBehavior(
      getSetting(APP_PREFERENCE_KEYS.closeBehavior)
    ),
    reduceMotion: parseBooleanPreference(
      getSetting(APP_PREFERENCE_KEYS.reduceMotion),
      APP_PREFERENCE_DEFAULTS.reduceMotion
    ),
    rememberBounds: parseBooleanPreference(
      getSetting(APP_PREFERENCE_KEYS.rememberBounds),
      APP_PREFERENCE_DEFAULTS.rememberBounds
    ),
    updateAutoUpdate: parseBooleanPreference(
      getSetting(APP_PREFERENCE_KEYS.updateAutoUpdate),
      APP_PREFERENCE_DEFAULTS.updateAutoUpdate
    ),
    updateReminder: parseBooleanPreference(
      getSetting(APP_PREFERENCE_KEYS.updateReminder),
      APP_PREFERENCE_DEFAULTS.updateReminder
    ),
  })
);

export const setAppPreference = os
  .input(
    z.object({
      key: z.enum([
        APP_PREFERENCE_KEYS.accentColor,
        APP_PREFERENCE_KEYS.closeBehavior,
        APP_PREFERENCE_KEYS.reduceMotion,
        APP_PREFERENCE_KEYS.rememberBounds,
        APP_PREFERENCE_KEYS.updateAutoUpdate,
        APP_PREFERENCE_KEYS.updateReminder,
      ]),
      value: z.string(),
    })
  )
  .handler(async ({ input }) => {
    if (input.key === APP_PREFERENCE_KEYS.accentColor) {
      setSetting(input.key, parseAccentColor(input.value));
    } else if (input.key === APP_PREFERENCE_KEYS.closeBehavior) {
      setSetting(input.key, parseCloseBehavior(input.value));
    } else if (input.key === APP_PREFERENCE_KEYS.reduceMotion) {
      setSetting(
        input.key,
        String(
          parseBooleanPreference(
            input.value,
            APP_PREFERENCE_DEFAULTS.reduceMotion
          )
        )
      );
    } else if (input.key === APP_PREFERENCE_KEYS.rememberBounds) {
      setSetting(
        input.key,
        String(
          parseBooleanPreference(
            input.value,
            APP_PREFERENCE_DEFAULTS.rememberBounds
          )
        )
      );
    } else if (input.key === APP_PREFERENCE_KEYS.updateAutoUpdate) {
      setSetting(
        input.key,
        String(
          parseBooleanPreference(
            input.value,
            APP_PREFERENCE_DEFAULTS.updateAutoUpdate
          )
        )
      );
    } else {
      setSetting(
        input.key,
        String(
          parseBooleanPreference(
            input.value,
            APP_PREFERENCE_DEFAULTS.updateReminder
          )
        )
      );
    }
    if (input.key === APP_PREFERENCE_KEYS.updateAutoUpdate) {
      const { setAutoUpdateEnabled } = await import(
        "@/services/update-manager"
      );
      setAutoUpdateEnabled(
        parseBooleanPreference(
          input.value,
          APP_PREFERENCE_DEFAULTS.updateAutoUpdate
        )
      );
    } else if (input.key === APP_PREFERENCE_KEYS.updateReminder) {
      const { setReminderEnabled } = await import("@/services/update-manager");
      setReminderEnabled(
        parseBooleanPreference(
          input.value,
          APP_PREFERENCE_DEFAULTS.updateReminder
        )
      );
    }
    return { ok: true };
  });

export const getDataPathInfo = os.handler(() => ({
  path: getDataPath(),
  isDefault: isDefaultDataPath(),
  isDevelopment: !app.isPackaged,
  profilePath: app.getPath("userData"),
}));

export const chooseDataPath = os
  .input(z.object({ title: z.string().min(1) }))
  .handler(async ({ input }) => {
    const window = BrowserWindow.getFocusedWindow();
    if (!window) {
      return { path: null };
    }
    const selection = await dialog.showOpenDialog(window, {
      properties: ["openDirectory", "createDirectory"],
      title: input.title,
    });
    return {
      path: selection.canceled ? null : (selection.filePaths[0] ?? null),
    };
  });

export const setDataPath = os
  .input(
    z.discriminatedUnion("mode", [
      z.strictObject({ mode: z.literal("create"), newPath: z.string().min(1) }),
      z.strictObject({ mode: z.literal("open"), newPath: z.string().min(1) }),
      z.strictObject({
        mode: z.literal("migrate"),
        newPath: z.string().min(1),
        cleanupSource: z.boolean().optional(),
      }),
    ])
  )
  .handler(({ input }) =>
    changeLibraryDirectory(input, (event) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.webContents.isDestroyed()) {
          window.webContents.send("data-path-migrate-progress", event);
        }
      }
    })
  );

export const getMirrorSettings = os.handler(() => {
  const mirror = getSetting("ai.mirror") || "auto";
  const customUrl = getSetting("ai.mirror.customUrl") || "";
  return { mirror, customUrl };
});

export const setMirrorSettings = os
  .input(
    z.object({
      mirror: z.string(),
      customUrl: z.string().optional(),
    })
  )
  .handler(({ input }) => {
    setSetting("ai.mirror", input.mirror);
    if (input.customUrl) {
      setSetting("ai.mirror.customUrl", input.customUrl);
    }
    return { ok: true };
  });

export const checkMirrorHealth = os.handler(async () => {
  const { checkAllMirrors } = await import("@/services/ai/mirror-health");
  const results = await checkAllMirrors();
  return { results };
});

const VIRTUAL_GPU_RE =
  /virtual|mumu|oray|remote\s*display|basic\s*display|hyper-?v|vmware|virtualbox|citrix|parsec|indirect\s*display/i;

export const getGpuSettings = os.handler(() => {
  const enabled = getSetting("gpu.enabled") === "true";
  const promptShown = getSetting("gpu.promptShown") === "true";
  let detected: Record<string, unknown> | null = null;
  const raw = getSetting("gpu.detected");
  if (raw) {
    try {
      detected = JSON.parse(raw);
      // Reject stale cache that captured a virtual display adapter
      // (e.g. OrayIddDriver, MuMu, Hyper-V) instead of the real GPU.
      if (
        detected &&
        typeof detected.gpuName === "string" &&
        VIRTUAL_GPU_RE.test(detected.gpuName)
      ) {
        detected = null;
      }
    } catch {
      /* ignore malformed */
    }
  }
  return { enabled, detected, promptShown };
});

export const setGpuSettings = os
  .input(
    z.object({
      enabled: z.boolean(),
    })
  )
  .handler(({ input }) => {
    setSetting("gpu.enabled", String(input.enabled));
    return { ok: true };
  });

export const checkGpuCapability = os.handler(async () => {
  const { probeGpuCapability, cacheDetectionResult, findModelsDir } =
    await import("@/services/gpu-detector");
  const modelsDir = findModelsDir();
  const result = await probeGpuCapability(modelsDir);
  cacheDetectionResult(result);
  return result;
});

export const markGpuPromptShown = os.handler(async () => {
  const { markPromptShown } = await import("@/services/gpu-detector");
  markPromptShown();
  return { ok: true };
});

export const getOpenAtLogin = os.handler(() => {
  return { openAtLogin: app.getLoginItemSettings().openAtLogin };
});

export const setOpenAtLogin = os
  .input(z.object({ openAtLogin: z.boolean() }))
  .handler(({ input }) => {
    app.setLoginItemSettings({ openAtLogin: input.openAtLogin });
    return { ok: true };
  });
