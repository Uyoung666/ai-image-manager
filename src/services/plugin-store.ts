import { and, eq, sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import {
  appSettings,
  pluginAssets,
  pluginInstallations,
  pluginPreferences,
} from "@/db/schema";

export const ACTIVE_PLUGIN_ID_SETTING_KEY = "plugins.activeId";

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface PluginInstallationInput {
  checksum?: string | null;
  installedAt?: number;
  lastErrorCode?: string | null;
  lastErrorDetail?: string | null;
  manifest?: JsonValue;
  /** Raw JSON is accepted at this boundary for callers reading a DB/export row. */
  manifestJson?: string;
  origin: string;
  pluginId: string;
  relativeLocation?: string | null;
  sourceLocation?: string | null;
  status?: string;
  version: string;
}

export interface PluginInstallationRecord {
  checksum: string | null;
  installedAt: number;
  lastErrorCode: string | null;
  lastErrorDetail: string | null;
  manifest: JsonValue;
  origin: string;
  pluginId: string;
  relativeLocation: string | null;
  sourceLocation: string | null;
  status: string;
  version: string;
}

export interface PluginPreferenceInput {
  lastKnownGoodVersion?: string | null;
  pluginId: string;
  selectedVersion?: string | null;
  settings?: JsonValue;
  /** Raw JSON is accepted at this boundary for callers reading a DB/export row. */
  settingsJson?: string;
  settingsSchemaVersion?: number;
  updatedAt?: number;
}

export interface PluginPreferenceRecord {
  lastKnownGoodVersion: string | null;
  pluginId: string;
  selectedVersion: string | null;
  settings: JsonValue;
  settingsSchemaVersion: number;
  updatedAt: number;
}

export interface PluginAssetInput {
  byteSize: number;
  managedPath: string;
  mimeType: string;
  pluginId: string;
  revision: string;
  settingId: string;
  updatedAt?: number;
}

export interface PluginAssetRecord extends PluginAssetInput {
  updatedAt: number;
}

export interface PreferenceAssetResetResult {
  assets: PluginAssetRecord[];
  preference: PluginPreferenceRecord;
}

export type InstallCommitInput =
  | (PluginInstallationInput & {
      activePluginId?: string | null;
      preference?: PluginPreferenceInput;
    })
  | {
      activePluginId?: string | null;
      installation: PluginInstallationInput;
      preference?: PluginPreferenceInput;
    };

export interface InstallCommitResult {
  activePluginId: string | null;
  installation: PluginInstallationRecord;
  preference: PluginPreferenceRecord | null;
}

export interface UninstallInput {
  pluginId: string;
  removeData: boolean;
  version?: string;
}

export interface UninstallResult {
  activePluginId: string | null;
  removedAssetCount: number;
  removedInstallationCount: number;
  removedPreference: boolean;
}

export interface LegacyAssetMigrationCandidate {
  managedPath: string | null;
  revision: string | null;
  settingId: string;
}

/**
 * A manifest-independent view of the old app_settings representation.
 * Enumerating candidates is read-only; callers must explicitly call
 * clearLegacyMigrationCandidate after a successful migration.
 */
export interface LegacyMigrationCandidate {
  assets: LegacyAssetMigrationCandidate[];
  enabled: boolean | null;
  pluginId: string;
  settings: JsonValue | null;
}

export class PluginStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PluginStoreError";
    this.code = code;
  }
}

type PluginDatabase = ReturnType<typeof getDatabase>;

const WINDOWS_PATH_PATTERN = /[A-Za-z]:[\\/][^\r\n]*/g;
const UNC_PATH_PATTERN = /\\\\[^\r\n\s]+/g;
const ABSOLUTE_PATH_PATTERN = /(^|[\s=("'])\/[^\r\n\s"')]+/g;

function sanitizeErrorMessage(error: unknown): string {
  let message = "unknown error";
  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === "string") {
    message = error;
  }
  return message
    .replace(WINDOWS_PATH_PATTERN, "<path>")
    .replace(UNC_PATH_PATTERN, "<path>")
    .replace(ABSOLUTE_PATH_PATTERN, "$1<path>")
    .slice(0, 240);
}

function storeError(code: string, error: unknown): PluginStoreError {
  return new PluginStoreError(code, sanitizeErrorMessage(error));
}

function serializeJson(value: JsonValue | undefined, field: string): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error(`${field} is not serializable`);
    }
    return serialized;
  } catch {
    throw new PluginStoreError("invalid-json", `${field} must be valid JSON`);
  }
}

function serializeJsonBoundary(
  value: JsonValue | undefined,
  rawValue: string | undefined,
  field: string,
  defaultValue: JsonValue
): string {
  if (value !== undefined) {
    return serializeJson(value, field);
  }
  if (rawValue !== undefined) {
    try {
      return serializeJson(JSON.parse(rawValue) as JsonValue, field);
    } catch {
      throw new PluginStoreError("invalid-json", `${field} must be valid JSON`);
    }
  }
  return serializeJson(defaultValue, field);
}

function parseJson(value: string, field: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    throw new PluginStoreError(
      "invalid-json",
      `Stored ${field} is invalid JSON`
    );
  }
}

function parseLegacyBoolean(value: string): boolean | null {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return null;
}

interface LegacyMutableCandidate {
  assets: Map<string, LegacyAssetMigrationCandidate>;
  enabled: boolean | null;
  pluginId: string;
  settings: JsonValue | null;
}

function legacyCandidateFor(
  candidates: Map<string, LegacyMutableCandidate>,
  pluginId: string
): LegacyMutableCandidate {
  const existing = candidates.get(pluginId);
  if (existing) {
    return existing;
  }
  const created: LegacyMutableCandidate = {
    assets: new Map(),
    enabled: null,
    pluginId,
    settings: null,
  };
  candidates.set(pluginId, created);
  return created;
}

function readLegacyAssetKey(
  rest: string
): { pluginId: string; settingId: string; revision: boolean } | null {
  for (const [marker, revision] of [
    [".assetRevision.", true],
    [".asset.", false],
  ] as const) {
    const markerIndex = rest.lastIndexOf(marker);
    if (markerIndex <= 0) {
      continue;
    }
    const pluginId = rest.slice(0, markerIndex);
    const settingId = rest.slice(markerIndex + marker.length);
    if (settingId) {
      return { pluginId, settingId, revision };
    }
  }
  return null;
}

function legacyPluginIdForKey(key: string): string | null {
  const prefix = "plugins.";
  if (!key.startsWith(prefix)) {
    return null;
  }
  const rest = key.slice(prefix.length);
  for (const suffix of [".enabled", ".settings"]) {
    if (rest.endsWith(suffix)) {
      const pluginId = rest.slice(0, -suffix.length);
      return pluginId || null;
    }
  }
  return readLegacyAssetKey(rest)?.pluginId ?? null;
}

function legacyMigrationCandidatesFromRows(
  rows: Array<{ key: string; value: string }>
): LegacyMigrationCandidate[] {
  const candidates = new Map<string, LegacyMutableCandidate>();

  for (const row of rows) {
    const pluginId = legacyPluginIdForKey(row.key);
    if (!pluginId) {
      continue;
    }
    const candidate = legacyCandidateFor(candidates, pluginId);
    const rest = row.key.slice("plugins.".length);
    if (rest === `${pluginId}.enabled`) {
      candidate.enabled = parseLegacyBoolean(row.value);
      continue;
    }
    if (rest === `${pluginId}.settings`) {
      try {
        candidate.settings = JSON.parse(row.value) as JsonValue;
      } catch {
        candidate.settings = null;
      }
      continue;
    }
    const assetKey = readLegacyAssetKey(rest);
    if (!assetKey) {
      continue;
    }
    const existing = candidate.assets.get(assetKey.settingId) ?? {
      managedPath: null,
      revision: null,
      settingId: assetKey.settingId,
    };
    if (assetKey.revision) {
      existing.revision = row.value || null;
    } else {
      existing.managedPath = row.value || null;
    }
    candidate.assets.set(assetKey.settingId, existing);
  }

  return [...candidates.values()]
    .sort((left, right) => left.pluginId.localeCompare(right.pluginId))
    .map((candidate) => ({
      assets: [...candidate.assets.values()].sort((left, right) =>
        left.settingId.localeCompare(right.settingId)
      ),
      enabled: candidate.enabled,
      pluginId: candidate.pluginId,
      settings: candidate.settings,
    }));
}

export class PluginStore {
  private readonly db: PluginDatabase;

  constructor(database?: PluginDatabase) {
    try {
      this.db = database ?? getDatabase();
    } catch (error) {
      throw storeError("database-init", error);
    }
  }

  upsertInstallation(input: PluginInstallationInput): PluginInstallationRecord {
    return this.run("installation-upsert", () => {
      const row = this.installationRow(input);
      this.db
        .insert(pluginInstallations)
        .values(row)
        .onConflictDoUpdate({
          target: [pluginInstallations.pluginId, pluginInstallations.version],
          set: {
            checksum: row.checksum,
            installedAt: row.installedAt,
            lastErrorCode: row.lastErrorCode,
            lastErrorDetail: row.lastErrorDetail,
            manifestJson: row.manifestJson,
            origin: row.origin,
            relativeLocation: row.relativeLocation,
            sourceLocation: row.sourceLocation,
            status: row.status,
          },
        })
        .run();
      return this.getInstallationUnsafe(row.pluginId, row.version);
    });
  }

  listInstallations(pluginId?: string): PluginInstallationRecord[] {
    return this.run("installation-list", () => {
      const rows = pluginId
        ? this.db
            .select()
            .from(pluginInstallations)
            .where(eq(pluginInstallations.pluginId, pluginId))
            .all()
        : this.db.select().from(pluginInstallations).all();
      return rows.map((row) => this.installationRecord(row));
    });
  }

  getInstallation(
    pluginId: string,
    version: string
  ): PluginInstallationRecord | null {
    return this.run("installation-get", () => {
      const row = this.getInstallationRow(pluginId, version);
      return row ? this.installationRecord(row) : null;
    });
  }

  deleteInstallation(pluginId: string, version: string): boolean {
    return this.run("installation-delete", () => {
      const result = this.db
        .delete(pluginInstallations)
        .where(
          and(
            eq(pluginInstallations.pluginId, pluginId),
            eq(pluginInstallations.version, version)
          )
        )
        .run();
      return result.changes > 0;
    });
  }

  getPreference(pluginId: string): PluginPreferenceRecord | null {
    return this.run("preference-get", () => this.getPreferenceUnsafe(pluginId));
  }

  upsertPreference(input: PluginPreferenceInput): PluginPreferenceRecord {
    return this.run("preference-upsert", () => {
      const row = this.preferenceRow(input);
      this.db
        .insert(pluginPreferences)
        .values(row)
        .onConflictDoUpdate({
          target: pluginPreferences.pluginId,
          set: {
            lastKnownGoodVersion: row.lastKnownGoodVersion,
            selectedVersion: row.selectedVersion,
            settingsJson: row.settingsJson,
            settingsSchemaVersion: row.settingsSchemaVersion,
            updatedAt: row.updatedAt,
          },
        })
        .run();
      const result = this.getPreferenceUnsafe(row.pluginId);
      if (!result) {
        throw new PluginStoreError(
          "preference-upsert",
          "Preference was not saved"
        );
      }
      return result;
    });
  }

  deletePreference(pluginId: string): boolean {
    return this.run("preference-delete", () => {
      const result = this.db
        .delete(pluginPreferences)
        .where(eq(pluginPreferences.pluginId, pluginId))
        .run();
      return result.changes > 0;
    });
  }

  getAsset(pluginId: string, settingId: string): PluginAssetRecord | null {
    return this.run("asset-get", () => {
      const row = this.db
        .select()
        .from(pluginAssets)
        .where(
          and(
            eq(pluginAssets.pluginId, pluginId),
            eq(pluginAssets.settingId, settingId)
          )
        )
        .get();
      return row ? this.assetRecord(row) : null;
    });
  }

  listAssets(pluginId: string): PluginAssetRecord[] {
    return this.run("asset-list", () =>
      this.db
        .select()
        .from(pluginAssets)
        .where(eq(pluginAssets.pluginId, pluginId))
        .all()
        .map((row) => this.assetRecord(row))
    );
  }

  upsertAsset(input: PluginAssetInput): PluginAssetRecord {
    return this.run("asset-upsert", () => {
      const row = {
        byteSize: input.byteSize,
        managedPath: input.managedPath,
        mimeType: input.mimeType,
        pluginId: input.pluginId,
        revision: input.revision,
        settingId: input.settingId,
        updatedAt: input.updatedAt ?? Date.now(),
      };
      this.db
        .insert(pluginAssets)
        .values(row)
        .onConflictDoUpdate({
          target: [pluginAssets.pluginId, pluginAssets.settingId],
          set: {
            byteSize: row.byteSize,
            managedPath: row.managedPath,
            mimeType: row.mimeType,
            revision: row.revision,
            updatedAt: row.updatedAt,
          },
        })
        .run();
      const result = this.getAsset(row.pluginId, row.settingId);
      if (!result) {
        throw new PluginStoreError("asset-upsert", "Asset was not saved");
      }
      return result;
    });
  }

  deleteAsset(pluginId: string, settingId: string): boolean {
    return this.run("asset-delete", () => {
      const result = this.db
        .delete(pluginAssets)
        .where(
          and(
            eq(pluginAssets.pluginId, pluginId),
            eq(pluginAssets.settingId, settingId)
          )
        )
        .run();
      return result.changes > 0;
    });
  }

  upsertPreferenceAndDeleteAssets(
    input: PluginPreferenceInput,
    settingIds: string[]
  ): PreferenceAssetResetResult {
    return this.run("preference-assets-reset", () => {
      const preference = this.preferenceRow(input);
      const uniqueSettingIds = [...new Set(settingIds)];
      const settingIdSet = new Set(uniqueSettingIds);
      let removedRows: (typeof pluginAssets.$inferSelect)[] = [];

      this.db.transaction((tx) => {
        if (uniqueSettingIds.length > 0) {
          removedRows = tx
            .select()
            .from(pluginAssets)
            .where(eq(pluginAssets.pluginId, input.pluginId))
            .all()
            .filter((row) => settingIdSet.has(row.settingId));
          for (const settingId of uniqueSettingIds) {
            tx.delete(pluginAssets)
              .where(
                and(
                  eq(pluginAssets.pluginId, input.pluginId),
                  eq(pluginAssets.settingId, settingId)
                )
              )
              .run();
          }
        }

        tx.insert(pluginPreferences)
          .values(preference)
          .onConflictDoUpdate({
            target: pluginPreferences.pluginId,
            set: {
              lastKnownGoodVersion: preference.lastKnownGoodVersion,
              selectedVersion: preference.selectedVersion,
              settingsJson: preference.settingsJson,
              settingsSchemaVersion: preference.settingsSchemaVersion,
              updatedAt: preference.updatedAt,
            },
          })
          .run();
      });

      const savedPreference = this.getPreferenceUnsafe(input.pluginId);
      if (!savedPreference) {
        throw new PluginStoreError(
          "preference-assets-reset",
          "Preference was not saved"
        );
      }
      return {
        assets: removedRows.map((row) => this.assetRecord(row)),
        preference: savedPreference,
      };
    });
  }

  getActivePluginId(): string | null {
    return this.run(
      "active-plugin-get",
      () =>
        this.db
          .select()
          .from(appSettings)
          .where(eq(appSettings.key, ACTIVE_PLUGIN_ID_SETTING_KEY))
          .get()?.value ?? null
    );
  }

  setActivePluginId(pluginId: string): void {
    this.run("active-plugin-set", () => {
      this.db
        .insert(appSettings)
        .values({
          key: ACTIVE_PLUGIN_ID_SETTING_KEY,
          updatedAt: Date.now(),
          value: pluginId,
        })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: { updatedAt: Date.now(), value: pluginId },
        })
        .run();
    });
  }

  clearActivePluginId(): boolean {
    return this.run("active-plugin-clear", () => {
      const result = this.db
        .delete(appSettings)
        .where(eq(appSettings.key, ACTIVE_PLUGIN_ID_SETTING_KEY))
        .run();
      return result.changes > 0;
    });
  }

  commitInstall(input: InstallCommitInput): InstallCommitResult {
    return this.run("install-commit", () => {
      const installationInput =
        "installation" in input ? input.installation : input;
      const installation = this.installationRow(installationInput);
      const preference = input.preference
        ? this.preferenceRow(input.preference)
        : null;

      this.db.transaction((tx) => {
        tx.insert(pluginInstallations)
          .values(installation)
          .onConflictDoUpdate({
            target: [pluginInstallations.pluginId, pluginInstallations.version],
            set: {
              checksum: installation.checksum,
              installedAt: installation.installedAt,
              lastErrorCode: installation.lastErrorCode,
              lastErrorDetail: installation.lastErrorDetail,
              manifestJson: installation.manifestJson,
              origin: installation.origin,
              relativeLocation: installation.relativeLocation,
              sourceLocation: installation.sourceLocation,
              status: installation.status,
            },
          })
          .run();

        if (preference) {
          tx.insert(pluginPreferences)
            .values(preference)
            .onConflictDoUpdate({
              target: pluginPreferences.pluginId,
              set: {
                lastKnownGoodVersion: preference.lastKnownGoodVersion,
                selectedVersion: preference.selectedVersion,
                settingsJson: preference.settingsJson,
                settingsSchemaVersion: preference.settingsSchemaVersion,
                updatedAt: preference.updatedAt,
              },
            })
            .run();
        }

        if (input.activePluginId !== undefined) {
          if (input.activePluginId === null) {
            tx.delete(appSettings)
              .where(eq(appSettings.key, ACTIVE_PLUGIN_ID_SETTING_KEY))
              .run();
          } else {
            tx.insert(appSettings)
              .values({
                key: ACTIVE_PLUGIN_ID_SETTING_KEY,
                updatedAt: Date.now(),
                value: input.activePluginId,
              })
              .onConflictDoUpdate({
                target: appSettings.key,
                set: { updatedAt: Date.now(), value: input.activePluginId },
              })
              .run();
          }
        }
      });

      return {
        activePluginId: this.getActivePluginId(),
        installation: this.getInstallationUnsafe(
          installation.pluginId,
          installation.version
        ),
        preference: this.getPreferenceUnsafe(
          preference?.pluginId ?? installation.pluginId
        ),
      };
    });
  }

  uninstall(input: UninstallInput): UninstallResult;
  uninstall(
    pluginId: string,
    removeData: boolean,
    version?: string
  ): UninstallResult;
  uninstall(
    inputOrPluginId: UninstallInput | string,
    removeData?: boolean,
    version?: string
  ): UninstallResult {
    const input: UninstallInput =
      typeof inputOrPluginId === "string"
        ? {
            pluginId: inputOrPluginId,
            removeData: removeData ?? false,
            version,
          }
        : inputOrPluginId;

    return this.run("uninstall", () => {
      let removedInstallationCount = 0;
      let removedAssetCount = 0;
      let removedPreference = false;

      this.db.transaction((tx) => {
        const activePluginId = tx
          .select({ value: appSettings.value })
          .from(appSettings)
          .where(eq(appSettings.key, ACTIVE_PLUGIN_ID_SETTING_KEY))
          .get()?.value;
        const installationCondition = input.version
          ? and(
              eq(pluginInstallations.pluginId, input.pluginId),
              eq(pluginInstallations.version, input.version)
            )
          : eq(pluginInstallations.pluginId, input.pluginId);
        removedInstallationCount = tx
          .delete(pluginInstallations)
          .where(installationCondition)
          .run().changes;

        if (input.removeData) {
          removedAssetCount = tx
            .delete(pluginAssets)
            .where(eq(pluginAssets.pluginId, input.pluginId))
            .run().changes;
          removedPreference =
            tx
              .delete(pluginPreferences)
              .where(eq(pluginPreferences.pluginId, input.pluginId))
              .run().changes > 0;
        }

        const remaining = tx
          .select()
          .from(pluginInstallations)
          .where(eq(pluginInstallations.pluginId, input.pluginId))
          .get();
        if (!remaining && activePluginId === input.pluginId) {
          tx.delete(appSettings)
            .where(eq(appSettings.key, ACTIVE_PLUGIN_ID_SETTING_KEY))
            .run();
        }
      });

      return {
        activePluginId: this.getActivePluginId(),
        removedAssetCount,
        removedInstallationCount,
        removedPreference,
      };
    });
  }

  listLegacyMigrationCandidates(): LegacyMigrationCandidate[] {
    return this.run("legacy-list", () => {
      const rows = this.db
        .select()
        .from(appSettings)
        .where(sql`${appSettings.key} LIKE ${"plugins.%"}`)
        .all();
      return legacyMigrationCandidatesFromRows(rows);
    });
  }

  getLegacyMigrationCandidates(): LegacyMigrationCandidate[] {
    return this.listLegacyMigrationCandidates();
  }

  /** Explicit cleanup step; enumeration and install/uninstall never call this. */
  clearLegacyMigrationCandidate(
    candidateOrPluginId: LegacyMigrationCandidate | string
  ): number {
    const pluginId =
      typeof candidateOrPluginId === "string"
        ? candidateOrPluginId
        : candidateOrPluginId.pluginId;
    return this.run("legacy-clear", () => {
      const rows = this.db
        .select({ key: appSettings.key })
        .from(appSettings)
        .where(sql`${appSettings.key} LIKE ${"plugins.%"}`)
        .all();
      const keys = rows
        .map(({ key }) => ({ key, pluginId: legacyPluginIdForKey(key) }))
        .filter((entry) => entry.pluginId === pluginId)
        .map(({ key }) => key);
      let deleted = 0;
      this.db.transaction((tx) => {
        for (const key of keys) {
          deleted += tx
            .delete(appSettings)
            .where(eq(appSettings.key, key))
            .run().changes;
        }
      });
      return deleted;
    });
  }

  clearLegacyMigration(pluginId: string): number {
    return this.clearLegacyMigrationCandidate(pluginId);
  }

  private installationRow(input: PluginInstallationInput) {
    if (input.manifest === undefined && input.manifestJson === undefined) {
      throw new PluginStoreError("invalid-json", "manifest is required");
    }
    const manifestJson = serializeJsonBoundary(
      input.manifest,
      input.manifestJson,
      "manifest",
      {}
    );
    return {
      checksum: input.checksum ?? null,
      installedAt: input.installedAt ?? Date.now(),
      lastErrorCode: input.lastErrorCode ?? null,
      lastErrorDetail: input.lastErrorDetail
        ? sanitizeErrorMessage(input.lastErrorDetail)
        : null,
      manifestJson,
      origin: input.origin,
      pluginId: input.pluginId,
      relativeLocation: input.relativeLocation ?? null,
      sourceLocation: input.sourceLocation ?? null,
      status: input.status ?? "installed",
      version: input.version,
    };
  }

  private preferenceRow(input: PluginPreferenceInput) {
    return {
      lastKnownGoodVersion: input.lastKnownGoodVersion ?? null,
      pluginId: input.pluginId,
      selectedVersion: input.selectedVersion ?? null,
      settingsJson: serializeJsonBoundary(
        input.settings,
        input.settingsJson,
        "settings",
        {}
      ),
      settingsSchemaVersion: input.settingsSchemaVersion ?? 1,
      updatedAt: input.updatedAt ?? Date.now(),
    };
  }

  private getInstallationUnsafe(
    pluginId: string,
    version: string
  ): PluginInstallationRecord {
    const row = this.getInstallationRow(pluginId, version);
    if (!row) {
      throw new PluginStoreError(
        "installation-not-found",
        "Installation was not saved"
      );
    }
    return this.installationRecord(row);
  }

  private getInstallationRow(
    pluginId: string,
    version: string
  ): typeof pluginInstallations.$inferSelect | undefined {
    return this.db
      .select()
      .from(pluginInstallations)
      .where(
        and(
          eq(pluginInstallations.pluginId, pluginId),
          eq(pluginInstallations.version, version)
        )
      )
      .get();
  }

  private getPreferenceUnsafe(pluginId: string): PluginPreferenceRecord | null {
    const row = this.db
      .select()
      .from(pluginPreferences)
      .where(eq(pluginPreferences.pluginId, pluginId))
      .get();
    return row ? this.preferenceRecord(row) : null;
  }

  private installationRecord(
    row: typeof pluginInstallations.$inferSelect
  ): PluginInstallationRecord {
    return {
      checksum: row.checksum,
      installedAt: row.installedAt,
      lastErrorCode: row.lastErrorCode,
      lastErrorDetail: row.lastErrorDetail,
      manifest: parseJson(row.manifestJson, "manifest"),
      origin: row.origin,
      pluginId: row.pluginId,
      relativeLocation: row.relativeLocation,
      sourceLocation: row.sourceLocation,
      status: row.status,
      version: row.version,
    };
  }

  private preferenceRecord(
    row: typeof pluginPreferences.$inferSelect
  ): PluginPreferenceRecord {
    return {
      lastKnownGoodVersion: row.lastKnownGoodVersion,
      pluginId: row.pluginId,
      selectedVersion: row.selectedVersion,
      settings: parseJson(row.settingsJson, "settings"),
      settingsSchemaVersion: row.settingsSchemaVersion,
      updatedAt: row.updatedAt,
    };
  }

  private assetRecord(
    row: typeof pluginAssets.$inferSelect
  ): PluginAssetRecord {
    return {
      byteSize: row.byteSize,
      managedPath: row.managedPath,
      mimeType: row.mimeType,
      pluginId: row.pluginId,
      revision: row.revision,
      settingId: row.settingId,
      updatedAt: row.updatedAt,
    };
  }

  private run<T>(operation: string, callback: () => T): T {
    try {
      return callback();
    } catch (error) {
      if (error instanceof PluginStoreError) {
        throw error;
      }
      throw storeError(operation, error);
    }
  }
}

export default PluginStore;
