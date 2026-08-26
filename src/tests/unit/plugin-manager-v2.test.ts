/** @vitest-environment node */
import fs, { createWriteStream } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  appSettings,
  pluginAssets,
  pluginInstallations,
  pluginPreferences,
} from "@/db/schema";
import { NEBULA_GLASS_MANIFEST } from "@/plugins/builtins/nebula-glass-manifest";

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
  dialog: {
    showOpenDialog: electronState.showOpenDialog,
  },
  protocol: {
    handle: vi.fn(),
  },
}));

import { PluginManager } from "@/services/plugin-manager";
import { PluginStore } from "@/services/plugin-store";

interface ZipLike {
  append: (data: string, options: { name: string }) => void;
  finalize: () => void;
  on: (event: string, listener: (error?: Error) => void) => void;
  pipe: (destination: NodeJS.WritableStream) => void;
}

type ZipArchiveConstructor = new (options: {
  zlib: { level: number };
}) => ZipLike;

const { ZipArchive } = createRequire(import.meta.url)("archiver") as {
  ZipArchive: ZipArchiveConstructor;
};

let testRoot = "";
let database: ReturnType<typeof drizzle>;
let sqlite: Database.Database;
let store: PluginStore;
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;

function writePng(filePath: string): void {
  const contents = Buffer.alloc(32, 7);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(contents);
  fs.writeFileSync(filePath, contents);
}

async function writePluginArchive(
  archivePath: string,
  manifest: Record<string, unknown>
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(archivePath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);
    archive.append(JSON.stringify(manifest), { name: "plugin.json" });
    archive.finalize();
  });
}

function applySchema(): void {
  const sql = fs.readFileSync(
    path.join(process.cwd(), "drizzle", "0044_add_plugin_persistence.sql"),
    "utf8"
  );
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) {
      sqlite.exec(statement);
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

beforeAll(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aim-plugin-manager-v2-"));
  electronState.userData = path.join(testRoot, "user-data");
  sqlite = new Database(":memory:");
  database = drizzle(sqlite, {
    schema: {
      appSettings,
      pluginAssets,
      pluginInstallations,
      pluginPreferences,
    },
  });
  applySchema();
  store = new PluginStore(database);
});

beforeEach(() => {
  electronState.showOpenDialog.mockReset();
  sqlite.exec(`
    DELETE FROM plugin_assets;
    DELETE FROM plugin_preferences;
    DELETE FROM plugin_installations;
    DELETE FROM app_settings;
  `);
  fs.rmSync(path.join(electronState.userData, "plugins"), {
    force: true,
    recursive: true,
  });
  fs.rmSync(path.join(electronState.userData, "plugins-data"), {
    force: true,
    recursive: true,
  });
});

afterAll(() => {
  sqlite.close();
  fs.rmSync(testRoot, { force: true, recursive: true });
});

describe("PluginManager v2 persistence boundary", () => {
  it("previews and commits a package without enabling a new plugin", async () => {
    const archivePath = path.join(testRoot, "preview.aim-plugin");
    await writePluginArchive(archivePath, {
      apiVersion: 1,
      author: { en: "Example", zh: "示例" },
      capabilities: ["theme"],
      description: { en: "Example", zh: "示例" },
      engine: { minAppVersion: "1.0.0" },
      id: "com.example.preview",
      manifestVersion: 1,
      name: { en: "Preview", zh: "预览" },
      settings: [],
      theme: {},
      version: "1.0.0",
    });
    electronState.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [archivePath],
    });
    const manager = new PluginManager([NEBULA_GLASS_MANIFEST], store);

    const preview = await manager.inspectFromDialog();
    expect(preview).toMatchObject({
      currentVersion: null,
      kind: "install",
      packageBytes: expect.any(Number),
      pluginId: "com.example.preview",
      source: "dialog",
      trust: "user-selected",
      version: "1.0.0",
    });
    expect(preview?.checksum).toMatch(CHECKSUM_PATTERN);
    await manager.commitInstall(preview?.token ?? "");

    expect(store.getInstallation("com.example.preview", "1.0.0")?.status).toBe(
      "installed"
    );
    expect(
      store.getPreference("com.example.preview")?.lastKnownGoodVersion
    ).toBeNull();
    expect(store.getActivePluginId()).toBeNull();
    const record = (await manager.list()).plugins.find(
      (plugin) => plugin.manifest.id === "com.example.preview"
    );
    expect(record?.enabled).toBe(false);
  });

  it("restores quarantined package files when uninstall persistence fails", async () => {
    const archivePath = path.join(testRoot, "uninstall-rollback.aim-plugin");
    await writePluginArchive(archivePath, {
      apiVersion: 1,
      author: { en: "Example", zh: "示例" },
      capabilities: ["theme"],
      description: { en: "Example", zh: "示例" },
      engine: { minAppVersion: "1.0.0" },
      id: "com.example.uninstall-rollback",
      manifestVersion: 1,
      name: { en: "Rollback", zh: "回滚" },
      settings: [],
      theme: {},
      version: "1.0.0",
    });
    electronState.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [archivePath],
    });
    const manager = new PluginManager([NEBULA_GLASS_MANIFEST], store);
    const preview = await manager.inspectFromDialog();
    await manager.commitInstall(preview?.token ?? "");
    const installedManifest = path.join(
      electronState.userData,
      "plugins",
      "com.example.uninstall-rollback",
      "1.0.0",
      "plugin.json"
    );
    const uninstallSpy = vi
      .spyOn(store, "uninstall")
      .mockImplementationOnce(() => {
        throw new Error("database unavailable");
      });

    await expect(
      manager.uninstall("com.example.uninstall-rollback")
    ).rejects.toThrow("database unavailable");
    uninstallSpy.mockRestore();
    expect(fs.existsSync(installedManifest)).toBe(true);
    expect(
      store.getInstallation("com.example.uninstall-rollback", "1.0.0")
    ).not.toBeNull();

    await manager.uninstall("com.example.uninstall-rollback");
    expect(fs.existsSync(installedManifest)).toBe(false);
    expect(
      store.getInstallation("com.example.uninstall-rollback", "1.0.0")
    ).toBeNull();
    expect(store.getPreference("com.example.uninstall-rollback")).toBeNull();
  });

  it("copies, replaces, and removes managed assets without serving source paths", async () => {
    const source = path.join(testRoot, "source.png");
    writePng(source);
    const manager = new PluginManager([NEBULA_GLASS_MANIFEST], store);
    electronState.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [source],
    });

    const snapshot = await manager.selectAsset(
      NEBULA_GLASS_MANIFEST.id,
      "wallpaper"
    );
    const asset = store.getAsset(NEBULA_GLASS_MANIFEST.id, "wallpaper");

    expect(asset?.managedPath).toContain("plugins-data");
    expect(asset?.managedPath).not.toBe(source);
    if (!asset) {
      throw new Error("Expected the selected asset to be persisted");
    }
    expect(fs.existsSync(source)).toBe(true);
    expect(
      snapshot.plugins.find(
        (plugin) => plugin.manifest.id === NEBULA_GLASS_MANIFEST.id
      )?.assetUrls.wallpaper
    ).toContain("aim-plugin-user://");

    const response = await manager.resolveUserAsset(
      snapshot.plugins.find(
        (plugin) => plugin.manifest.id === NEBULA_GLASS_MANIFEST.id
      )?.assetUrls.wallpaper ?? "aim-plugin-user://missing/wallpaper"
    );
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toHaveLength(32);

    const failedReplacement = path.join(testRoot, "failed-replacement.png");
    writePng(failedReplacement);
    electronState.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [failedReplacement],
    });
    const preferenceSpy = vi
      .spyOn(store, "upsertPreference")
      .mockImplementationOnce(() => {
        throw new Error("preference write failed");
      });
    await expect(
      manager.selectAsset(NEBULA_GLASS_MANIFEST.id, "wallpaper")
    ).rejects.toThrow("preference write failed");
    preferenceSpy.mockRestore();
    expect(
      store.getAsset(NEBULA_GLASS_MANIFEST.id, "wallpaper")?.managedPath
    ).toBe(asset.managedPath);
    expect(fs.existsSync(asset.managedPath)).toBe(true);
    expect(fs.readdirSync(path.dirname(asset.managedPath))).toEqual([
      path.basename(asset.managedPath),
    ]);

    await manager.resetSettings(NEBULA_GLASS_MANIFEST.id, ["wallpaper"]);
    expect(store.getAsset(NEBULA_GLASS_MANIFEST.id, "wallpaper")).toBeNull();
    expect(fs.existsSync(asset.managedPath)).toBe(false);
    expect(
      (
        store.getPreference(NEBULA_GLASS_MANIFEST.id)?.settings as Record<
          string,
          unknown
        >
      ).wallpaper
    ).toBe("");

    const replacement = path.join(testRoot, "replacement.png");
    writePng(replacement);
    electronState.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [replacement],
    });
    await manager.selectAsset(NEBULA_GLASS_MANIFEST.id, "wallpaper");
    const replacementAsset = store.getAsset(
      NEBULA_GLASS_MANIFEST.id,
      "wallpaper"
    );
    expect(replacementAsset?.managedPath).not.toBe(asset?.managedPath);
    expect(asset?.managedPath && fs.existsSync(asset.managedPath)).toBe(false);
    expect(
      replacementAsset?.managedPath &&
        fs.existsSync(replacementAsset.managedPath)
    ).toBe(true);

    await manager.removeAsset(NEBULA_GLASS_MANIFEST.id, "wallpaper");
    expect(fs.existsSync(source)).toBe(true);
    expect(fs.existsSync(replacement)).toBe(true);
    expect(
      replacementAsset?.managedPath &&
        fs.existsSync(replacementAsset.managedPath)
    ).toBe(false);
  });

  it("serves the selected installation version and active id from the store", async () => {
    const pluginId = "com.example.versioned";
    const root = path.join(electronState.userData, "plugins", pluginId);
    for (const version of ["1.0.0", "2.0.0"]) {
      const directory = path.join(root, version);
      fs.mkdirSync(path.join(directory, "assets"), { recursive: true });
      fs.writeFileSync(
        path.join(directory, "plugin.json"),
        JSON.stringify({
          apiVersion: 1,
          author: { en: "Example", zh: "示例" },
          capabilities: ["theme"],
          description: { en: "Example", zh: "示例" },
          engine: { minAppVersion: "1.0.0" },
          id: pluginId,
          manifestVersion: 1,
          name: { en: "Example", zh: "示例" },
          settings: [],
          theme: {
            backdrop: { asset: "assets/cover.png", effect: "image" },
          },
          version,
        }),
        "utf8"
      );
      writePng(path.join(directory, "assets", "cover.png"));
      store.upsertInstallation({
        lastErrorCode: version === "2.0.0" ? "activation-failed" : undefined,
        lastErrorDetail: version === "2.0.0" ? "new version failed" : undefined,
        manifest: JSON.parse(
          fs.readFileSync(path.join(directory, "plugin.json"), "utf8")
        ),
        origin: "local",
        pluginId,
        relativeLocation: path
          .relative(electronState.userData, directory)
          .replaceAll(path.sep, "/"),
        status: version === "2.0.0" ? "failed" : "installed",
        version,
      });
    }
    store.upsertPreference({
      pluginId,
      selectedVersion: "1.0.0",
      settings: {},
    });
    store.setActivePluginId(pluginId);

    const manager = new PluginManager([NEBULA_GLASS_MANIFEST], store);
    const snapshot = await manager.list();
    const record = snapshot.plugins.find(
      (plugin) => plugin.manifest.id === pluginId
    );

    expect(record?.manifest.version).toBe("1.0.0");
    expect(record?.status).toBe("active");
    expect(record?.error).toBe("new version failed");
    const resourceUrl = record?.assetUrls.backdrop;
    expect(resourceUrl).toContain("aim-plugin://");
    expect(resourceUrl).toContain("/1.0.0/assets/cover.png");
    const response = await manager.resolveResource(resourceUrl ?? "");
    expect(response.status).toBe(200);
  });

  it("maps literal v2 assets by path and stores opaque selection markers", async () => {
    const pluginId = "com.example.v2-assets";
    const version = "1.0.0";
    const directory = path.join(
      electronState.userData,
      "plugins",
      pluginId,
      version
    );
    fs.mkdirSync(path.join(directory, "assets"), { recursive: true });
    const manifest = {
      apiVersion: 2,
      author: { name: "Example" },
      capabilities: ["theme"],
      description: { en: "Example", zh: "示例" },
      engine: { minAppVersion: "1.0.0" },
      id: pluginId,
      manifestVersion: 2,
      name: { en: "Example", zh: "示例" },
      settings: [
        {
          defaultValue: null,
          id: "wallpaper",
          label: { en: "Wallpaper", zh: "壁纸" },
          type: "image",
        },
      ],
      settingGroups: [],
      themeFile: "theme.json",
      version,
    };
    fs.writeFileSync(
      path.join(directory, "plugin.json"),
      JSON.stringify(manifest)
    );
    fs.writeFileSync(
      path.join(directory, "theme.json"),
      JSON.stringify({
        layers: [
          { asset: "assets/cover.png", id: "literal", type: "image" },
          {
            asset: { setting: "wallpaper" },
            id: "bound",
            type: "image",
          },
        ],
      })
    );
    writePng(path.join(directory, "assets", "cover.png"));
    store.upsertInstallation({
      manifest,
      origin: "local",
      pluginId,
      relativeLocation: path
        .relative(electronState.userData, directory)
        .replaceAll(path.sep, "/"),
      version,
    });
    const manager = new PluginManager([NEBULA_GLASS_MANIFEST], store);
    const initial = await manager.list();
    const initialRecord = initial.plugins.find(
      (plugin) => plugin.manifest.id === pluginId
    );
    expect(initialRecord?.assetUrls["assets/cover.png"]).toContain(
      "/1.0.0/assets/cover.png"
    );

    const source = path.join(testRoot, "v2-source.png");
    writePng(source);
    electronState.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [source],
    });
    await manager.selectAsset(pluginId, "wallpaper");
    const selected = store.getPreference(pluginId);
    const revision = store.getAsset(pluginId, "wallpaper")?.revision;
    expect(selected?.settings).toMatchObject({ wallpaper: revision });

    await manager.removeAsset(pluginId, "wallpaper");
    expect(store.getPreference(pluginId)?.settings).toMatchObject({
      wallpaper: null,
    });
  });

  it("rolls an activation failure back to the last known good version", async () => {
    const pluginId = "com.example.activation";
    for (const version of ["1.0.0", "2.0.0"]) {
      store.upsertInstallation({
        manifest: { id: pluginId, version },
        origin: "local",
        pluginId,
        version,
      });
    }
    store.upsertPreference({
      lastKnownGoodVersion: "1.0.0",
      pluginId,
      selectedVersion: "2.0.0",
      settings: { mode: "dark" },
    });
    store.setActivePluginId(pluginId);
    const manager = new PluginManager([NEBULA_GLASS_MANIFEST], store);

    await manager.reportActivationResult(
      pluginId,
      "2.0.0",
      false,
      "theme-load-failed",
      "C:/private/theme.json"
    );

    expect(store.getPreference(pluginId)).toMatchObject({
      lastKnownGoodVersion: "1.0.0",
      selectedVersion: "1.0.0",
    });
    expect(store.getInstallation(pluginId, "2.0.0")).toMatchObject({
      lastErrorCode: "theme-load-failed",
      lastErrorDetail: "<path>",
      status: "failed",
    });
    expect(store.getActivePluginId()).toBe(pluginId);
  });
});
