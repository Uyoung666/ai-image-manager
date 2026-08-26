/** @vitest-environment node */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appSettings,
  pluginAssets,
  pluginInstallations,
  pluginPreferences,
} from "@/db/schema";

const sqlite = new Database(":memory:");
const database = drizzle(sqlite, {
  schema: {
    appSettings,
    pluginAssets,
    pluginInstallations,
    pluginPreferences,
  },
});

function applyPluginMigration(): void {
  const migration = fs.readFileSync(
    path.join(process.cwd(), "drizzle", "0044_add_plugin_persistence.sql"),
    "utf8"
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    const sql = statement.trim();
    if (sql) {
      sqlite.exec(sql);
    }
  }
}

function tableInfo(tableName: string): Array<{
  name: string;
  notnull: number;
  pk: number;
}> {
  return sqlite.pragma(`table_info('${tableName}')`) as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
}

afterAll(() => {
  sqlite.close();
});

describe("plugin persistence migration", () => {
  beforeEach(() => {
    for (const table of [
      "plugin_assets",
      "plugin_preferences",
      "plugin_installations",
    ]) {
      sqlite.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    applyPluginMigration();
  });

  it("creates the three tables with the requested keys and columns", () => {
    expect(tableInfo("plugin_installations")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "plugin_id", pk: 1, notnull: 1 }),
        expect.objectContaining({ name: "version", pk: 2, notnull: 1 }),
        expect.objectContaining({ name: "relative_location" }),
        expect.objectContaining({ name: "source_location" }),
        expect.objectContaining({ name: "last_error_code" }),
        expect.objectContaining({ name: "last_error_detail" }),
      ])
    );
    expect(tableInfo("plugin_preferences")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "plugin_id", pk: 1 }),
        expect.objectContaining({ name: "selected_version" }),
        expect.objectContaining({ name: "last_known_good_version" }),
        expect.objectContaining({ name: "settings_json", notnull: 1 }),
        expect.objectContaining({
          name: "settings_schema_version",
          notnull: 1,
        }),
        expect.objectContaining({ name: "updated_at", notnull: 1 }),
      ])
    );
    expect(tableInfo("plugin_assets")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "plugin_id", pk: 1, notnull: 1 }),
        expect.objectContaining({ name: "setting_id", pk: 2, notnull: 1 }),
        expect.objectContaining({ name: "managed_path", notnull: 1 }),
        expect.objectContaining({ name: "revision", notnull: 1 }),
        expect.objectContaining({ name: "mime_type", notnull: 1 }),
        expect.objectContaining({ name: "byte_size", notnull: 1 }),
      ])
    );
  });

  it("supports versioned installations while retaining preferences and assets", () => {
    database
      .insert(pluginInstallations)
      .values([
        {
          pluginId: "com.example.demo",
          version: "1.0.0",
          origin: "local",
          relativeLocation: "plugins/com.example.demo/1.0.0",
          checksum: "sha256:one",
          manifestJson: JSON.stringify({
            id: "com.example.demo",
            version: "1.0.0",
          }),
          installedAt: 100,
          status: "installed",
        },
        {
          pluginId: "com.example.demo",
          version: "2.0.0",
          origin: "local",
          relativeLocation: "plugins/com.example.demo/2.0.0",
          checksum: "sha256:two",
          manifestJson: JSON.stringify({
            id: "com.example.demo",
            version: "2.0.0",
          }),
          installedAt: 200,
          status: "installed",
        },
      ])
      .run();
    database
      .insert(pluginPreferences)
      .values({
        pluginId: "com.example.demo",
        selectedVersion: "2.0.0",
        lastKnownGoodVersion: "1.0.0",
        settingsJson: JSON.stringify({ enabled: true }),
        settingsSchemaVersion: 2,
        updatedAt: 300,
      })
      .run();
    database
      .insert(pluginAssets)
      .values({
        pluginId: "com.example.demo",
        settingId: "wallpaper",
        managedPath: "plugins-data/com.example.demo/wallpaper.png",
        revision: "revision-1",
        mimeType: "image/png",
        byteSize: 42,
        updatedAt: 300,
      })
      .run();

    expect(database.select().from(pluginInstallations).all()).toHaveLength(2);
    expect(database.select().from(pluginPreferences).get()).toMatchObject({
      pluginId: "com.example.demo",
      selectedVersion: "2.0.0",
    });
    expect(database.select().from(pluginAssets).get()).toMatchObject({
      pluginId: "com.example.demo",
      settingId: "wallpaper",
    });

    sqlite
      .prepare(
        "DELETE FROM plugin_installations WHERE plugin_id = ? AND version = ?"
      )
      .run("com.example.demo", "1.0.0");

    expect(database.select().from(pluginPreferences).all()).toHaveLength(1);
    expect(database.select().from(pluginAssets).all()).toHaveLength(1);
  });
});

const settingsSqlite = new Database(":memory:");
let settingsDatabase: ReturnType<typeof drizzle>;

vi.mock("@/db", () => ({
  getDatabase: () => settingsDatabase,
}));

import {
  deleteSetting,
  deleteSettingsByPrefix,
  getAllSettings,
  setSetting,
} from "@/services/settings-manager";

describe("settings-manager deletion helpers", () => {
  beforeEach(() => {
    settingsSqlite.exec("DROP TABLE IF EXISTS app_settings");
    settingsSqlite.exec(`
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    settingsDatabase = drizzle(settingsSqlite, { schema: { appSettings } });
  });

  afterAll(() => {
    settingsSqlite.close();
  });

  it("deletes one key and parameterized prefix matches only", () => {
    setSetting("plugins.activeId", "demo");
    setSetting("plugins.demo.settings", "{}");
    setSetting("pluginsX.keep", "yes");
    setSetting("other.keep", "yes");

    deleteSetting("plugins.activeId");
    expect(getAllSettings().map(({ key }) => key)).not.toContain(
      "plugins.activeId"
    );

    deleteSettingsByPrefix("plugins.");
    expect(getAllSettings().map(({ key }) => key)).toEqual([
      "pluginsX.keep",
      "other.keep",
    ]);
  });
});
