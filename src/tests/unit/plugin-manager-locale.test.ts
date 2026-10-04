/** @vitest-environment node */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { canonicalizePluginSignatureEntries } from "@/plugins/manifest";

const electronState = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  userData: "",
}));

vi.mock("electron", () => ({
  app: {
    getLocale: () => "en-US",
    getPath: () => electronState.userData,
    getVersion: () => "2.0.0",
  },
  dialog: { showOpenDialog: electronState.showOpenDialog },
  protocol: { handle: vi.fn() },
}));

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { pluginInstallations, pluginPreferences } from "@/db/schema";
import { PluginManager } from "@/services/plugin-manager";
import { PluginStore } from "@/services/plugin-store";

let testRoot: string;
let userData: string;
const PLUGIN_NOT_FOUND_PATTERN = /不存在/;
const { publicKey, privateKey } = generateKeyPairSync("ed25519");

function manifest() {
  return {
    apiVersion: 3,
    author: { name: "Example Studio" },
    capabilities: ["locale"],
    description: {
      en: "Japanese UI translation.",
      "ja-JP": "日本語 UI 翻訳。",
    },
    engine: { minAppVersion: "1.0.0" },
    id: "com.example.japanese-locale",
    locale: {
      catalogVersion: "1.0.0",
      direction: "ltr",
      fallback: "en",
      mainFile: "locales/ja-JP/main.json",
      nativeName: "日本語",
      rendererFile: "locales/ja-JP/renderer.json",
      tag: "ja-JP",
    },
    manifestVersion: 3,
    name: { en: "Japanese", "ja-JP": "日本語" },
    version: "1.0.0",
  };
}

async function writeLocaleDirectory(
  signed: boolean,
  directory = path.join(userData, "plugins", manifest().id, "1.0.0"),
  version = "1.0.0"
): Promise<string> {
  const localeDirectory = path.join(directory, "locales", "ja-JP");
  await fs.mkdir(localeDirectory, { recursive: true });
  const files = new Map<string, Buffer>([
    [
      "plugin.json",
      Buffer.from(JSON.stringify({ ...manifest(), version }), "utf8"),
    ],
    [
      "locales/ja-JP/renderer.json",
      Buffer.from(JSON.stringify({ close: "閉じる" }), "utf8"),
    ],
    [
      "locales/ja-JP/main.json",
      Buffer.from(JSON.stringify({ open: "開く" }), "utf8"),
    ],
  ]);
  for (const [relative, data] of files) {
    await fs.writeFile(path.join(directory, relative), data);
  }
  if (signed) {
    const entries = [...files].map(([relative, data]) => ({
      path: relative,
      sha256: createHash("sha256").update(data).digest("hex"),
      size: data.length,
    }));
    const signature = sign(
      null,
      Buffer.from(canonicalizePluginSignatureEntries(entries), "utf8"),
      privateKey
    ).toString("base64");
    await fs.writeFile(
      path.join(directory, "signature.json"),
      JSON.stringify({ algorithm: "ed25519", keyId: "test", signature }),
      "utf8"
    );
  }
  return directory;
}

describe("PluginManager locale provider trust boundary", () => {
  beforeAll(async () => {
    testRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "aim-plugin-manager-locale-")
    );
    userData = path.join(testRoot, "user-data");
    electronState.userData = userData;
  });

  beforeEach(async () => {
    await fs.rm(path.join(userData, "plugins"), {
      recursive: true,
      force: true,
    });
    electronState.showOpenDialog.mockReset();
  });

  afterAll(async () => {
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  it("loads a signed local locale and returns no filesystem path", async () => {
    await writeLocaleDirectory(true);
    const manager = new PluginManager([], null as never, { test: publicKey });

    const providers = await manager.listLocaleProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      catalogVersion: "1.0.0",
      pluginId: manifest().id,
      signed: true,
      signerKeyId: "test",
      tag: "ja-JP",
      trust: "trusted",
      version: "1.0.0",
    });
    expect(providers[0]).not.toHaveProperty("directory");
    expect(providers[0]?.renderer).toEqual({ close: "閉じる" });
    const snapshot = await manager.list();
    expect(snapshot.plugins[0]?.locale).toMatchObject({
      catalogVersion: "1.0.0",
      coverage: { available: true, total: expect.any(Number), translated: 1 },
      nativeName: "日本語",
      signed: true,
      signerKeyId: "test",
      tag: "ja-JP",
      trust: "trusted",
    });
    expect(snapshot.plugins[0]?.locale).not.toHaveProperty("directory");
    await expect(
      manager.loadLocaleProvider(manifest().id)
    ).resolves.toMatchObject({
      trust: "trusted",
    });
  });

  it("rejects an unsigned local package", async () => {
    const id = "com.example.unsigned-locale";
    const directory = path.join(userData, "plugins", id, "1.0.0");
    const unsignedManifest = { ...manifest(), id };
    await writeLocaleDirectory(false, directory);
    await fs.writeFile(
      path.join(directory, "plugin.json"),
      JSON.stringify(unsignedManifest),
      "utf8"
    );
    const manager = new PluginManager([], null as never, { test: publicKey });

    await expect(manager.listLocaleProviders()).resolves.toEqual([]);
    await expect(manager.loadLocaleProvider(id)).rejects.toThrow(
      PLUGIN_NOT_FOUND_PATTERN
    );
  });

  it("allows unsigned developer directories with developer trust", async () => {
    const directory = await writeLocaleDirectory(
      false,
      path.join(testRoot, "developer-locale")
    );
    electronState.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [directory],
    });
    const manager = new PluginManager([], null as never, { test: publicKey });
    await manager.setDeveloperMode(true);
    await manager.loadDevDirectoryFromDialog();

    await expect(
      manager.loadLocaleProvider(manifest().id)
    ).resolves.toMatchObject({
      signed: false,
      trust: "developer",
    });
  });

  it("honors the selected version and restores a verified last good version after a corrupt upgrade", async () => {
    const sqlite = new Database(":memory:");
    try {
      const migration = await fs.readFile(
        path.resolve("drizzle/0044_add_plugin_persistence.sql"),
        "utf8"
      );
      for (const sql of migration.split("--> statement-breakpoint")) {
        if (sql.trim()) {
          sqlite.exec(sql);
        }
      }
      const store = new PluginStore(
        drizzle(sqlite, { schema: { pluginInstallations, pluginPreferences } })
      );
      const id = manifest().id;
      const first = await writeLocaleDirectory(true);
      const second = await writeLocaleDirectory(
        true,
        path.join(userData, "plugins", id, "1.1.0"),
        "1.1.0"
      );
      for (const version of ["1.0.0", "1.1.0"]) {
        store.upsertInstallation({
          pluginId: id,
          version,
          origin: "local",
          status: "installed",
          manifest: { ...manifest(), version },
          relativeLocation: `plugins/${id}/${version}`,
        });
      }
      const manager = new PluginManager([], store, { test: publicKey });
      manager.recordLocaleSelection(id, "1.0.0");
      expect((await manager.loadLocaleProvider(id)).version).toBe("1.0.0");
      store.upsertPreference({
        pluginId: id,
        selectedVersion: "1.1.0",
        lastKnownGoodVersion: "1.0.0",
        settings: {},
      });
      expect((await manager.loadLocaleProvider(id)).version).toBe("1.1.0");
      manager.recordLocaleSelection(id, "1.1.0");
      expect(store.getPreference(id)?.lastKnownGoodVersion).toBe("1.1.0");
      await fs.writeFile(
        path.join(second, "locales/ja-JP/renderer.json"),
        JSON.stringify({ close: "Tampered" })
      );
      expect((await manager.loadLocaleProvider(id)).version).toBe("1.0.0");
      expect(store.getPreference(id)?.selectedVersion).toBe("1.0.0");
      expect((await manager.listLocaleProviders())[0]?.version).toBe("1.0.0");
      await fs.writeFile(
        path.join(first, "locales/ja-JP/main.json"),
        JSON.stringify({ open: "Tampered too" })
      );
      await expect(manager.loadLocaleProvider(id)).rejects.toThrow();
    } finally {
      sqlite.close();
    }
  });
});
