/** @vitest-environment node */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  appSettings,
  pluginAssets,
  pluginInstallations,
  pluginPreferences,
} from "@/db/schema";
import {
  ACTIVE_PLUGIN_ID_SETTING_KEY,
  PluginStore,
  PluginStoreError,
} from "@/services/plugin-store";

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
  sqlite.exec(`
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

const store = new PluginStore(database);

beforeAll(() => {
  applyPluginMigration();
});

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM plugin_assets;
    DELETE FROM plugin_preferences;
    DELETE FROM plugin_installations;
    DELETE FROM app_settings;
  `);
});

afterAll(() => {
  sqlite.close();
});

describe("PluginStore installation, preferences and assets", () => {
  it("serializes JSON at the write boundary and parses it at the read boundary", () => {
    const installation = store.upsertInstallation({
      installedAt: 100,
      manifest: { id: "com.example.demo", settings: { enabled: true } },
      origin: "local",
      pluginId: "com.example.demo",
      status: "installed",
      version: "1.0.0",
    });
    const preference = store.upsertPreference({
      pluginId: "com.example.demo",
      selectedVersion: "1.0.0",
      settings: { enabled: true, opacity: 0.5 },
      settingsSchemaVersion: 3,
      updatedAt: 200,
    });

    expect(installation.manifest).toEqual({
      id: "com.example.demo",
      settings: { enabled: true },
    });
    expect(preference.settings).toEqual({ enabled: true, opacity: 0.5 });
    expect(
      sqlite
        .prepare("SELECT manifest_json FROM plugin_installations")
        .pluck()
        .get()
    ).toBe(
      JSON.stringify({ id: "com.example.demo", settings: { enabled: true } })
    );
    expect(
      sqlite
        .prepare("SELECT settings_json FROM plugin_preferences")
        .pluck()
        .get()
    ).toBe(JSON.stringify({ enabled: true, opacity: 0.5 }));
  });

  it("uses exact composite keys and supports asset list/delete", () => {
    store.upsertInstallation({
      manifest: { version: "1.0.0" },
      origin: "local",
      pluginId: "com.example.demo",
      version: "1.0.0",
    });
    store.upsertInstallation({
      manifest: { version: "2.0.0" },
      origin: "local",
      pluginId: "com.example.demo",
      version: "2.0.0",
    });
    store.upsertAsset({
      byteSize: 10,
      managedPath: "plugin-data/com.example.demo/a.png",
      mimeType: "image/png",
      pluginId: "com.example.demo",
      revision: "r1",
      settingId: "wallpaper",
    });
    store.upsertAsset({
      byteSize: 20,
      managedPath: "plugin-data/com.example.demo/b.png",
      mimeType: "image/png",
      pluginId: "com.example.demo",
      revision: "r2",
      settingId: "logo",
    });

    expect(store.listInstallations("com.example.demo")).toHaveLength(2);
    expect(
      store.getInstallation("com.example.demo", "1.0.0")?.manifest
    ).toEqual({
      version: "1.0.0",
    });
    expect(store.listAssets("com.example.demo")).toHaveLength(2);
    expect(store.deleteAsset("com.example.demo", "wallpaper")).toBe(true);
    expect(store.getAsset("com.example.demo", "wallpaper")).toBeNull();
    expect(store.deleteInstallation("com.example.demo", "1.0.0")).toBe(true);
    expect(store.getInstallation("com.example.demo", "2.0.0")).not.toBeNull();
  });

  it("resets preferences and selected asset records in one transaction", () => {
    store.upsertPreference({
      pluginId: "com.example.demo",
      settings: { logo: "r2", wallpaper: "r1" },
    });
    for (const [settingId, revision] of [
      ["wallpaper", "r1"],
      ["logo", "r2"],
    ] as const) {
      store.upsertAsset({
        byteSize: 10,
        managedPath: `plugin-data/com.example.demo/${settingId}.png`,
        mimeType: "image/png",
        pluginId: "com.example.demo",
        revision,
        settingId,
      });
    }

    const result = store.upsertPreferenceAndDeleteAssets(
      {
        pluginId: "com.example.demo",
        settings: { logo: "r2", wallpaper: null },
      },
      ["wallpaper"]
    );

    expect(result.assets.map((asset) => asset.settingId)).toEqual([
      "wallpaper",
    ]);
    expect(result.preference.settings).toEqual({
      logo: "r2",
      wallpaper: null,
    });
    expect(store.getAsset("com.example.demo", "wallpaper")).toBeNull();
    expect(store.getAsset("com.example.demo", "logo")).not.toBeNull();

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      store.upsertPreferenceAndDeleteAssets(
        {
          pluginId: "com.example.demo",
          settings: cyclic as never,
        },
        ["logo"]
      )
    ).toThrow(PluginStoreError);
    expect(store.getAsset("com.example.demo", "logo")).not.toBeNull();
  });
});

describe("PluginStore transactions and active plugin", () => {
  it("commits installation, preference and active id atomically", () => {
    const result = store.commitInstall({
      activePluginId: "com.example.demo",
      installation: {
        manifest: { id: "com.example.demo" },
        origin: "local",
        pluginId: "com.example.demo",
        version: "1.0.0",
      },
      preference: {
        pluginId: "com.example.demo",
        selectedVersion: "1.0.0",
        settings: { enabled: true },
      },
    });

    expect(result.installation.version).toBe("1.0.0");
    expect(result.preference?.selectedVersion).toBe("1.0.0");
    expect(store.getActivePluginId()).toBe("com.example.demo");
    expect(
      sqlite
        .prepare("SELECT value FROM app_settings WHERE key = ?")
        .pluck()
        .get(ACTIVE_PLUGIN_ID_SETTING_KEY)
    ).toBe("com.example.demo");
  });

  it("rolls back all commit writes when an installation write fails", () => {
    expect(() =>
      store.commitInstall({
        activePluginId: "com.example.broken",
        installation: {
          manifest: { id: "com.example.broken" },
          origin: "local",
          pluginId: undefined,
          version: "1.0.0",
        } as unknown as {
          manifest: { id: string };
          origin: string;
          pluginId: string;
          version: string;
        },
        preference: {
          pluginId: "com.example.broken",
          settings: { enabled: true },
        },
      })
    ).toThrow(PluginStoreError);

    expect(store.getInstallation("com.example.broken", "1.0.0")).toBeNull();
    expect(store.getPreference("com.example.broken")).toBeNull();
    expect(store.getActivePluginId()).toBeNull();
  });

  it("uninstalls installation rows transactionally and controls retained data", () => {
    store.commitInstall({
      activePluginId: "com.example.demo",
      installation: {
        manifest: { id: "com.example.demo" },
        origin: "local",
        pluginId: "com.example.demo",
        version: "1.0.0",
      },
      preference: {
        pluginId: "com.example.demo",
        settings: { enabled: true },
      },
    });
    store.upsertAsset({
      byteSize: 12,
      managedPath: "plugin-data/com.example.demo/a.png",
      mimeType: "image/png",
      pluginId: "com.example.demo",
      revision: "r1",
      settingId: "wallpaper",
    });

    const retained = store.uninstall("com.example.demo", false);
    expect(retained.removedInstallationCount).toBe(1);
    expect(store.getPreference("com.example.demo")).not.toBeNull();
    expect(store.listAssets("com.example.demo")).toHaveLength(1);
    expect(store.getActivePluginId()).toBeNull();

    const removed = store.uninstall({
      pluginId: "com.example.demo",
      removeData: true,
    });
    expect(removed.removedPreference).toBe(true);
    expect(removed.removedAssetCount).toBe(1);
    expect(store.getPreference("com.example.demo")).toBeNull();
    expect(store.listAssets("com.example.demo")).toEqual([]);
  });

  it("does not clear another plugin's active id", () => {
    store.commitInstall({
      activePluginId: "com.example.active",
      installation: {
        manifest: { id: "com.example.active" },
        origin: "local",
        pluginId: "com.example.active",
        version: "1.0.0",
      },
    });
    store.upsertInstallation({
      manifest: { id: "com.example.other" },
      origin: "local",
      pluginId: "com.example.other",
      version: "1.0.0",
    });

    store.uninstall("com.example.other", false);

    expect(store.getActivePluginId()).toBe("com.example.active");
  });
});

describe("PluginStore legacy migration candidates", () => {
  it("enumerates legacy keys without deleting them", () => {
    database
      .insert(appSettings)
      .values([
        {
          key: "plugins.com.example.demo.enabled",
          updatedAt: 1,
          value: "true",
        },
        {
          key: "plugins.com.example.demo.settings",
          updatedAt: 1,
          value: JSON.stringify({ enabled: true }),
        },
        {
          key: "plugins.com.example.demo.asset.wallpaper",
          updatedAt: 1,
          value: "C:/Users/private/wallpaper.png",
        },
        {
          key: "plugins.com.example.demo.assetRevision.wallpaper",
          updatedAt: 1,
          value: "revision-1",
        },
        {
          key: ACTIVE_PLUGIN_ID_SETTING_KEY,
          updatedAt: 1,
          value: "com.example.demo",
        },
      ])
      .run();

    const candidates = store.listLegacyMigrationCandidates();
    expect(candidates).toEqual([
      {
        assets: [
          {
            managedPath: "C:/Users/private/wallpaper.png",
            revision: "revision-1",
            settingId: "wallpaper",
          },
        ],
        enabled: true,
        pluginId: "com.example.demo",
        settings: { enabled: true },
      },
    ]);
    expect(store.getActivePluginId()).toBe("com.example.demo");
    expect(store.getLegacyMigrationCandidates()).toHaveLength(1);

    expect(store.clearLegacyMigrationCandidate(candidates[0])).toBe(4);
    expect(store.listLegacyMigrationCandidates()).toEqual([]);
    expect(store.getActivePluginId()).toBe("com.example.demo");
  });

  it("does not leak private paths through serialization errors", () => {
    const circular: Record<string, unknown> = {};
    circular.path = "C:/Users/private/secret.png";
    circular.self = circular;

    expect(() =>
      store.upsertInstallation({
        manifest: circular as never,
        origin: "local",
        pluginId: "com.example.invalid",
        version: "1.0.0",
      })
    ).toThrowError("manifest must be valid JSON");

    try {
      store.upsertInstallation({
        manifest: circular as never,
        origin: "local",
        pluginId: "com.example.invalid",
        version: "1.0.0",
      });
    } catch (error) {
      expect(String(error)).not.toContain("C:/Users/private");
    }
  });
});
