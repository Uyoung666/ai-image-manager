import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { app, dialog, protocol } from "electron";
import yauzl from "yauzl";
import { z } from "zod";
import {
  migrateNebulaGlassSettings,
  NEBULA_GLASS_PLUGIN_ID,
  NEBULA_GLASS_RECIPE_VERSION,
} from "@/plugins/builtins/nebula-glass-manifest";
import {
  getLocalizedText,
  parsePluginManifest,
  parsePluginTheme,
  validatePluginSettings,
} from "@/plugins/manifest";
import type {
  PluginManifestV1,
  PluginRecord,
  PluginSettingDefinition,
  PluginSnapshot,
} from "@/plugins/types";
import { createLogger } from "@/utils/logger";
import { getSetting, setSetting } from "./settings-manager";

const log = createLogger("plugin-manager");

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_COUNT = 256;
const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const PLUGIN_ROOT = "plugins";
const LEADING_SLASH_PATTERN = /^\//;
const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const VERSION_PART_PATTERN = /[.+-]/;
const PRIVATE_PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\/)[^\s]+/g;
const BYTE_RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/;
const ALLOWED_ASSET_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".jpeg",
  ".jpg",
  ".mp4",
  ".png",
  ".webm",
  ".webp",
]);
const IMAGE_ASSET_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
]);
const VIDEO_ASSET_EXTENSIONS = new Set([".mp4", ".webm"]);

const mimeTypes: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".webm": "video/webm",
  ".webp": "image/webp",
};

interface ByteRange {
  end: number;
  start: number;
}

function parseByteRange(value: string, size: number): ByteRange | null {
  const match = BYTE_RANGE_PATTERN.exec(value.trim());
  if (!match || size <= 0) {
    return null;
  }
  const [, startValue, endValue] = match;
  if (!(startValue || endValue)) {
    return null;
  }
  if (!startValue) {
    const suffixLength = Number(endValue);
    if (!(Number.isSafeInteger(suffixLength) && suffixLength > 0)) {
      return null;
    }
    return {
      end: size - 1,
      start: Math.max(size - suffixLength, 0),
    };
  }
  const start = Number(startValue);
  const requestedEnd = endValue ? Number(endValue) : size - 1;
  if (
    !(Number.isSafeInteger(start) && Number.isSafeInteger(requestedEnd)) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return null;
  }
  return { end: Math.min(requestedEnd, size - 1), start };
}

async function streamAssetResponse(
  filePath: string,
  rangeHeader?: string | null
): Promise<Response> {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) {
    return new Response(null, { status: 404 });
  }
  const headers = new Headers({
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "content-type":
      mimeTypes[path.extname(filePath).toLowerCase()] ??
      "application/octet-stream",
    "x-content-type-options": "nosniff",
  });
  let range: ByteRange | undefined;
  if (rangeHeader) {
    const parsed = parseByteRange(rangeHeader, stat.size);
    if (!parsed) {
      headers.set("content-range", `bytes */${stat.size}`);
      return new Response(null, { headers, status: 416 });
    }
    range = parsed;
    headers.set(
      "content-range",
      `bytes ${range.start}-${range.end}/${stat.size}`
    );
    headers.set("content-length", String(range.end - range.start + 1));
  } else {
    headers.set("content-length", String(stat.size));
  }
  const body = Readable.toWeb(
    fs.createReadStream(filePath, range)
  ) as unknown as ReadableStream;
  return new Response(body, {
    headers,
    status: range ? 206 : 200,
  });
}

const pluginAssetInputSchema = z.object({
  pluginId: z.string(),
  settingId: z.string(),
});

const pluginPatchSchema = z.object({
  pluginId: z.string(),
  settings: z.record(
    z.string(),
    z.union([z.boolean(), z.number(), z.string()])
  ),
});

function compareVersions(left: string, right: string): number {
  const a = left.split(VERSION_PART_PATTERN).slice(0, 3).map(Number);
  const b = right.split(VERSION_PART_PATTERN).slice(0, 3).map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) {
      return (a[index] ?? 0) - (b[index] ?? 0);
    }
  }
  return 0;
}

function isSafeRelativePath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return (
    normalized.length > 0 &&
    !normalized.startsWith("/") &&
    !normalized.includes("\0") &&
    !normalized.split("/").some((part) => part === ".." || part.length === 0)
  );
}

function isContained(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative === "" || !(relative.startsWith("..") || path.isAbsolute(relative))
  );
}

function pluginDirectory(): string {
  return path.join(app.getPath("userData"), PLUGIN_ROOT);
}

function pluginSettingsKey(pluginId: string): string {
  return `plugins.${pluginId}.settings`;
}

function pluginEnabledKey(pluginId: string): string {
  return `plugins.${pluginId}.enabled`;
}

function pluginRecipeVersionKey(pluginId: string): string {
  return `plugins.${pluginId}.recipeVersion`;
}

function pluginAssetKey(pluginId: string, settingId: string): string {
  return `plugins.${pluginId}.asset.${settingId}`;
}

function pluginAssetRevisionKey(pluginId: string, settingId: string): string {
  return `plugins.${pluginId}.assetRevision.${settingId}`;
}

function userAssetUrl(
  pluginId: string,
  settingId: string,
  revision: string | null
): string {
  const base = `aim-plugin-user://${encodeURIComponent(pluginId)}/${encodeURIComponent(settingId)}`;
  return revision ? `${base}?revision=${encodeURIComponent(revision)}` : base;
}

function pluginResourceUrl(pluginId: string, relativePath: string): string {
  const encodedPath = relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `aim-plugin://${encodeURIComponent(pluginId)}/${encodedPath}`;
}

function normalizePluginSettings(
  manifest: PluginManifestV1,
  source: "builtin" | "local",
  parsedSettings: Record<string, unknown>
) {
  const storedRecipeVersion = Number(
    getSetting(pluginRecipeVersionKey(manifest.id))
  );
  const migrateBuiltinRecipe =
    source === "builtin" &&
    manifest.id === NEBULA_GLASS_PLUGIN_ID &&
    (!Number.isFinite(storedRecipeVersion) ||
      storedRecipeVersion < NEBULA_GLASS_RECIPE_VERSION);
  const settings = validatePluginSettings(
    manifest,
    migrateBuiltinRecipe
      ? migrateNebulaGlassSettings(parsedSettings)
      : parsedSettings
  );
  if (migrateBuiltinRecipe) {
    setSetting(pluginSettingsKey(manifest.id), JSON.stringify(settings));
    setSetting(
      pluginRecipeVersionKey(manifest.id),
      String(NEBULA_GLASS_RECIPE_VERSION)
    );
  }
  return settings;
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(PRIVATE_PATH_PATTERN, "<path>").slice(0, 240)
    : "unknown error";
}

function invalidManifest(id: string, version: string): PluginManifestV1 {
  return {
    apiVersion: 1,
    author: { en: "Unknown", zh: "未知" },
    capabilities: ["theme"],
    description: { en: "Invalid plugin package.", zh: "插件包无效。" },
    engine: { minAppVersion: "999.999.999" },
    id,
    manifestVersion: 1,
    name: { en: id, zh: id },
    settings: [],
    theme: {},
    version,
  };
}

function settingFor(
  manifest: PluginManifestV1,
  id: string
): PluginSettingDefinition | undefined {
  return manifest.settings.find((setting) => setting.id === id);
}

async function detectAssetKind(
  filePath: string,
  extension: string
): Promise<"image" | "video"> {
  if (!ALLOWED_ASSET_EXTENSIONS.has(extension)) {
    throw new Error("插件资源扩展名不受支持");
  }
  const stat = await fsp.stat(filePath);
  if (stat.size > MAX_ASSET_BYTES) {
    throw new Error("插件资源超过大小限制");
  }
  const handle = await fsp.open(filePath, "r");
  const header = Buffer.alloc(32);
  try {
    await handle.read(header, 0, header.length, 0);
  } finally {
    await handle.close();
  }
  const isImageSignature =
    (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) ||
    header
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    header.subarray(0, 6).toString("ascii") === "GIF89a" ||
    header.subarray(0, 6).toString("ascii") === "GIF87a" ||
    (header.subarray(0, 4).toString("ascii") === "RIFF" &&
      header.subarray(8, 12).toString("ascii") === "WEBP") ||
    (header.subarray(4, 8).toString("ascii") === "ftyp" &&
      (header.subarray(8, 12).toString("ascii") === "avif" ||
        header.subarray(8, 12).toString("ascii") === "avis"));
  const isVideoSignature =
    header.subarray(0, 4).toString("ascii") === "\x1aE\xdf\xa3" ||
    (extension === ".mp4" &&
      header.subarray(4, 8).toString("ascii") === "ftyp");
  const isImage = IMAGE_ASSET_EXTENSIONS.has(extension) && isImageSignature;
  const isVideo = VIDEO_ASSET_EXTENSIONS.has(extension) && isVideoSignature;
  if (!(isImage || isVideo)) {
    throw new Error("插件资源 MIME 类型无法验证");
  }
  return isImage ? "image" : "video";
}

async function extractArchive(
  zipPath: string,
  destination: string
): Promise<void> {
  const stat = await fsp.stat(zipPath);
  if (stat.size > MAX_ARCHIVE_BYTES) {
    throw new Error("插件包超过大小限制");
  }
  await fsp.mkdir(destination, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    yauzl.open(
      zipPath,
      { lazyEntries: true, autoClose: true },
      (error, zipFile) => {
        if (error || !zipFile) {
          reject(error ?? new Error("无法读取插件包"));
          return;
        }
        let count = 0;
        let extracted = 0;
        const names = new Set<string>();
        let settled = false;
        const fail = (reason: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          zipFile.close();
          reject(reason instanceof Error ? reason : new Error(String(reason)));
        };
        zipFile.on("error", fail);
        zipFile.on("end", () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        });
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: archive validation must reject every unsafe entry before extraction
        zipFile.on("entry", (entry: yauzl.Entry) => {
          if (settled) {
            return;
          }
          count += 1;
          if (count > MAX_ENTRY_COUNT) {
            fail(new Error("插件包条目数量超过限制"));
            return;
          }
          const rawEntryName = entry.fileName.replaceAll("\\", "/");
          const isDirectory = rawEntryName.endsWith("/");
          const entryName = isDirectory
            ? rawEntryName.slice(0, -1)
            : rawEntryName;
          if (!isSafeRelativePath(entryName)) {
            fail(new Error("插件包包含不安全路径"));
            return;
          }
          if (names.has(entryName.toLowerCase())) {
            fail(new Error("插件包包含重复文件"));
            return;
          }
          names.add(entryName.toLowerCase());
          if (isDirectory) {
            if (entryName !== "assets" && !entryName.startsWith("assets/")) {
              fail(new Error("插件包包含不允许的目录"));
              return;
            }
            zipFile.readEntry();
            return;
          }
          const isManifest =
            entryName === "plugin.json" || entryName === "theme.json";
          const extension = path.extname(entryName).toLowerCase();
          const isAsset = entryName.startsWith("assets/");
          if (
            !(
              isManifest ||
              (isAsset && ALLOWED_ASSET_EXTENSIONS.has(extension))
            )
          ) {
            fail(new Error(`插件包包含不允许的文件：${entryName}`));
            return;
          }
          if (
            entry.uncompressedSize > MAX_EXTRACTED_BYTES ||
            extracted + entry.uncompressedSize > MAX_EXTRACTED_BYTES
          ) {
            fail(new Error("插件包解压后超过大小限制"));
            return;
          }
          const target = path.resolve(destination, entryName);
          if (!isContained(target, destination)) {
            fail(new Error("插件包目标路径越界"));
            return;
          }
          // biome-ignore lint/suspicious/noBitwiseOperators: ZIP external attributes are bit fields by specification
          const unixMode = (entry.externalFileAttributes >>> 16) & 0xff_ff;
          // biome-ignore lint/suspicious/noBitwiseOperators: ZIP external attributes are bit fields by specification
          if ((unixMode & 0o17_0000) === 0o12_0000) {
            fail(new Error("插件包不允许符号链接"));
            return;
          }
          (async () => {
            try {
              await fsp.mkdir(path.dirname(target), { recursive: true });
              zipFile.openReadStream(entry, (streamError, stream) => {
                if (streamError || !stream) {
                  fail(streamError ?? new Error("无法读取插件条目"));
                  return;
                }
                const output = fs.createWriteStream(target, { flags: "wx" });
                let bytes = 0;
                stream.on("data", (chunk: Buffer) => {
                  bytes += chunk.length;
                  extracted += chunk.length;
                  if (
                    bytes > MAX_ASSET_BYTES ||
                    extracted > MAX_EXTRACTED_BYTES
                  ) {
                    stream.destroy(new Error("插件条目超过大小限制"));
                  }
                });
                stream.on("error", fail);
                output.on("error", fail);
                output.on("close", () => {
                  if (settled) {
                    return;
                  }
                  if (isAsset) {
                    detectAssetKind(target, extension).then(
                      () => zipFile.readEntry(),
                      fail
                    );
                  } else {
                    zipFile.readEntry();
                  }
                });
                stream.pipe(output);
              });
            } catch (error) {
              fail(error);
            }
          })().catch(fail);
        });
        zipFile.readEntry();
      }
    );
  });
}

function appCompatible(manifest: PluginManifestV1): boolean {
  return compareVersions(app.getVersion(), manifest.engine.minAppVersion) >= 0;
}

function readInstalledManifest(directory: string): PluginManifestV1 {
  const manifest = parsePluginManifest(
    readJson(path.join(directory, "plugin.json"))
  );
  if (manifest.themeFile) {
    const themePath = path.join(directory, manifest.themeFile);
    if (!(isContained(themePath, directory) && fs.existsSync(themePath))) {
      throw new Error("插件主题文件不存在");
    }
    manifest.theme = parsePluginTheme(readJson(themePath));
  }
  return manifest;
}

export class PluginManager {
  private readonly builtins: PluginManifestV1[];

  constructor(builtins: PluginManifestV1[]) {
    this.builtins = builtins;
  }

  async ensureRoot(): Promise<void> {
    await fsp.mkdir(pluginDirectory(), { recursive: true });
  }

  private async installedManifests(): Promise<
    Array<{ directory: string; error?: string; manifest: PluginManifestV1 }>
  > {
    await this.ensureRoot();
    const results: Array<{
      directory: string;
      error?: string;
      manifest: PluginManifestV1;
    }> = [];
    for (const idEntry of await fsp.readdir(pluginDirectory(), {
      withFileTypes: true,
    })) {
      if (!idEntry.isDirectory()) {
        continue;
      }
      const idDirectory = path.join(pluginDirectory(), idEntry.name);
      for (const versionEntry of await fsp.readdir(idDirectory, {
        withFileTypes: true,
      })) {
        if (!versionEntry.isDirectory()) {
          continue;
        }
        const directory = path.join(idDirectory, versionEntry.name);
        try {
          const manifest = await readInstalledManifest(directory);
          results.push({ directory, manifest });
        } catch (error) {
          // Invalid packages remain on disk for diagnostics, but are not activated.
          log.warn(
            {
              directory: path.basename(directory),
              error: safeErrorMessage(error),
            },
            "invalid plugin package"
          );
          const fallbackId = PLUGIN_ID_PATTERN.test(idEntry.name)
            ? idEntry.name
            : "local.invalid.plugin";
          const fallbackVersion = SEMVER_PATTERN.test(versionEntry.name)
            ? versionEntry.name
            : "0.0.0";
          results.push({
            directory,
            error: safeErrorMessage(error),
            manifest: invalidManifest(fallbackId, fallbackVersion),
          });
        }
      }
    }
    return results;
  }

  private recordFor(
    manifest: PluginManifestV1,
    source: "builtin" | "local",
    directory?: string,
    error?: string
  ): PluginRecord {
    const rawSettings = getSetting(pluginSettingsKey(manifest.id));
    let parsedSettings: Record<string, unknown> = {};
    if (rawSettings) {
      try {
        parsedSettings = JSON.parse(rawSettings) as Record<string, unknown>;
      } catch {
        parsedSettings = {};
      }
    }
    const settings = normalizePluginSettings(manifest, source, parsedSettings);
    const enabled = getSetting(pluginEnabledKey(manifest.id)) === "true";
    const compatible = appCompatible(manifest);
    const assetUrls: Record<string, string> = {};
    for (const setting of manifest.settings) {
      if (setting.type !== "image" && setting.type !== "video") {
        continue;
      }
      if (getSetting(pluginAssetKey(manifest.id, setting.id))) {
        assetUrls[setting.id] = userAssetUrl(
          manifest.id,
          setting.id,
          getSetting(pluginAssetRevisionKey(manifest.id, setting.id))
        );
      }
    }
    if (directory && manifest.theme.backdrop?.asset) {
      const relativeAsset = manifest.theme.backdrop.asset;
      const assetPath = path.resolve(directory, relativeAsset);
      if (
        isContained(assetPath, directory) &&
        relativeAsset.startsWith("assets/") &&
        fs.existsSync(assetPath)
      ) {
        assetUrls.backdrop = pluginResourceUrl(manifest.id, relativeAsset);
      }
    }
    const hasDirectory = source === "builtin" || Boolean(directory);
    let status: PluginRecord["status"] = "disabled";
    if (error) {
      status = "invalid";
    } else if (!compatible) {
      status = "incompatible";
    } else if (enabled && hasDirectory) {
      status = "active";
    }
    return {
      assetUrls,
      enabled: enabled && compatible && hasDirectory,
      error,
      manifest,
      settings,
      source,
      status,
    };
  }

  async list(): Promise<PluginSnapshot> {
    const installed = await this.installedManifests();
    const installedById = new Map<
      string,
      { directory: string; error?: string; manifest: PluginManifestV1 }
    >();
    for (const item of installed) {
      const current = installedById.get(item.manifest.id);
      if (
        !current ||
        compareVersions(item.manifest.version, current.manifest.version) > 0
      ) {
        installedById.set(item.manifest.id, item);
      }
    }
    const records: PluginRecord[] = [];
    for (const manifest of this.builtins) {
      records.push(await this.recordFor(manifest, "builtin"));
    }
    for (const { directory, error, manifest } of installedById.values()) {
      if (this.builtins.some((builtin) => builtin.id === manifest.id)) {
        continue;
      }
      records.push(await this.recordFor(manifest, "local", directory, error));
    }
    return { plugins: records };
  }

  async installFromDialog(): Promise<PluginSnapshot> {
    const result = await dialog.showOpenDialog({
      filters: [
        { extensions: ["aim-plugin"], name: "AI Image Manager Plugin" },
      ],
      properties: ["openFile"],
      title: getLocalizedText(
        { en: "Install plugin", zh: "安装插件" },
        app.getLocale()
      ),
    });
    if (result.canceled || !result.filePaths[0]) {
      return this.list();
    }
    const archivePath = path.resolve(result.filePaths[0]);
    const stage = path.join(
      pluginDirectory(),
      `.staging-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    try {
      await extractArchive(archivePath, stage);
      const manifest = parsePluginManifest(
        readJson(path.join(stage, "plugin.json"))
      );
      if (manifest.themeFile) {
        const themePath = path.join(stage, manifest.themeFile);
        manifest.theme = parsePluginTheme(readJson(themePath));
        await fsp.writeFile(
          path.join(stage, "plugin.json"),
          JSON.stringify(manifest, null, 2),
          "utf8"
        );
      }
      const target = path.join(
        pluginDirectory(),
        manifest.id,
        manifest.version
      );
      if (!isContained(target, pluginDirectory())) {
        throw new Error("插件安装路径非法");
      }
      if (fs.existsSync(target)) {
        throw new Error("相同版本插件已安装");
      }
      const current = (await this.installedManifests()).find(
        (item) => item.manifest.id === manifest.id
      );
      if (
        current &&
        compareVersions(manifest.version, current.manifest.version) <= 0
      ) {
        throw new Error("只能安装更高版本的插件");
      }
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.rename(stage, target);
    } catch (error) {
      log.warn(
        {
          archive: path.basename(archivePath),
          error: safeErrorMessage(error),
        },
        "plugin install failed"
      );
      throw error;
    } finally {
      if (fs.existsSync(stage)) {
        await fsp.rm(stage, { recursive: true, force: true });
      }
    }
    return this.list();
  }

  async setEnabled(
    pluginId: string,
    enabled: boolean
  ): Promise<PluginSnapshot> {
    const snapshot = await this.list();
    const target = snapshot.plugins.find(
      (plugin) => plugin.manifest.id === pluginId
    );
    if (!target) {
      throw new Error("插件不存在");
    }
    if (target.status === "incompatible" || target.status === "invalid") {
      throw new Error("插件与当前应用不兼容");
    }
    if (enabled) {
      for (const plugin of snapshot.plugins) {
        if (plugin.manifest.capabilities.includes("theme")) {
          setSetting(
            pluginEnabledKey(plugin.manifest.id),
            plugin.manifest.id === pluginId ? "true" : "false"
          );
        }
      }
    } else {
      setSetting(pluginEnabledKey(pluginId), "false");
    }
    return this.list();
  }

  async setSettings(
    pluginId: string,
    settings: Record<string, unknown>
  ): Promise<PluginSnapshot> {
    const snapshot = await this.list();
    const target = snapshot.plugins.find(
      (plugin) => plugin.manifest.id === pluginId
    );
    if (!target) {
      throw new Error("插件不存在");
    }
    const merged = validatePluginSettings(target.manifest, {
      ...target.settings,
      ...settings,
    });
    setSetting(pluginSettingsKey(pluginId), JSON.stringify(merged));
    return this.list();
  }

  async selectAsset(
    pluginId: string,
    settingId: string
  ): Promise<PluginSnapshot> {
    const snapshot = await this.list();
    const target = snapshot.plugins.find(
      (plugin) => plugin.manifest.id === pluginId
    );
    const definition = target && settingFor(target.manifest, settingId);
    if (
      !(target && definition) ||
      (definition.type !== "image" && definition.type !== "video")
    ) {
      throw new Error("插件资源设置不存在");
    }
    const extensions =
      definition.type === "image"
        ? ["png", "jpg", "jpeg", "webp", "avif", "gif"]
        : ["mp4", "webm"];
    const result = await dialog.showOpenDialog({
      filters: [
        { extensions, name: definition.type === "image" ? "Image" : "Video" },
      ],
      properties: ["openFile"],
    });
    if (!result.canceled && result.filePaths[0]) {
      const selected = path.resolve(result.filePaths[0]);
      const detected = await detectAssetKind(
        selected,
        path.extname(selected).toLowerCase()
      );
      if (detected !== definition.type) {
        throw new Error("插件资源类型与设置不匹配");
      }
      setSetting(pluginAssetKey(pluginId, settingId), selected);
      setSetting(pluginAssetRevisionKey(pluginId, settingId), randomUUID());
    }
    return this.list();
  }

  async uninstall(pluginId: string): Promise<PluginSnapshot> {
    const snapshot = await this.list();
    const target = snapshot.plugins.find(
      (plugin) => plugin.manifest.id === pluginId
    );
    if (!target) {
      throw new Error("插件不存在");
    }
    if (target.source === "builtin") {
      throw new Error("内置插件不能卸载");
    }
    const installed = (await this.installedManifests()).filter(
      (item) => item.manifest.id === pluginId
    );
    for (const item of installed) {
      if (isContained(item.directory, pluginDirectory())) {
        await fsp.rm(item.directory, { recursive: true, force: true });
      }
    }
    setSetting(pluginEnabledKey(pluginId), "false");
    return this.list();
  }

  async resolveResource(
    requestUrl: string,
    rangeHeader?: string | null
  ): Promise<Response> {
    let pluginId: string;
    let relative: string;
    try {
      const url = new URL(requestUrl);
      pluginId = decodeURIComponent(url.hostname);
      relative = decodeURIComponent(
        url.pathname.replace(LEADING_SLASH_PATTERN, "")
      );
    } catch {
      return new Response(null, { status: 400 });
    }
    if (!isSafeRelativePath(relative)) {
      return new Response(null, { status: 400 });
    }
    if (!relative.startsWith("assets/")) {
      return new Response(null, { status: 403 });
    }
    const installed = (await this.installedManifests()).find(
      (item) => item.manifest.id === pluginId
    );
    if (!installed) {
      return new Response(null, { status: 404 });
    }
    const target = path.resolve(installed.directory, relative);
    if (!(isContained(target, installed.directory) && fs.existsSync(target))) {
      return new Response(null, { status: 404 });
    }
    try {
      const [realDirectory, realTarget] = await Promise.all([
        fsp.realpath(installed.directory),
        fsp.realpath(target),
      ]);
      if (!isContained(realTarget, realDirectory)) {
        return new Response(null, { status: 403 });
      }
    } catch {
      return new Response(null, { status: 404 });
    }
    try {
      await detectAssetKind(target, path.extname(target).toLowerCase());
    } catch {
      return new Response(null, { status: 403 });
    }
    return streamAssetResponse(target, rangeHeader);
  }

  async resolveUserAsset(
    requestUrl: string,
    rangeHeader?: string | null
  ): Promise<Response> {
    let pluginId: string;
    let settingId: string;
    try {
      const url = new URL(requestUrl);
      pluginId = decodeURIComponent(url.hostname);
      settingId = decodeURIComponent(
        url.pathname.replace(LEADING_SLASH_PATTERN, "")
      );
    } catch {
      return new Response(null, { status: 400 });
    }
    const filePath = getSetting(pluginAssetKey(pluginId, settingId));
    if (!(filePath && path.isAbsolute(filePath) && fs.existsSync(filePath))) {
      return new Response(null, { status: 404 });
    }
    const snapshot = await this.list();
    const plugin = snapshot.plugins.find(
      (record) => record.manifest.id === pluginId
    );
    const definition = plugin && settingFor(plugin.manifest, settingId);
    if (
      !definition ||
      (definition.type !== "image" && definition.type !== "video")
    ) {
      return new Response(null, { status: 403 });
    }
    try {
      const detected = await detectAssetKind(
        filePath,
        path.extname(filePath).toLowerCase()
      );
      if (detected !== definition.type) {
        return new Response(null, { status: 403 });
      }
    } catch {
      return new Response(null, { status: 403 });
    }
    return streamAssetResponse(filePath, rangeHeader);
  }
}

let manager: PluginManager | undefined;

export function configurePluginManager(
  builtins: PluginManifestV1[]
): PluginManager {
  manager ??= new PluginManager(builtins);
  return manager;
}

export function getPluginManager(): PluginManager {
  if (!manager) {
    throw new Error("Plugin manager has not been configured");
  }
  return manager;
}

export function registerPluginProtocols(): void {
  const current = getPluginManager();
  // Electron only allows protocol handlers to be registered once per process.
  // The main process calls this during app.whenReady(), before the renderer loads.
  protocol.handle("aim-plugin", (request) =>
    current.resolveResource(request.url, request.headers.get("range"))
  );
  protocol.handle("aim-plugin-user", (request) =>
    current.resolveUserAsset(request.url, request.headers.get("range"))
  );
}

export function validatePluginPatch(input: unknown) {
  return pluginPatchSchema.parse(input);
}

export function validatePluginAssetInput(input: unknown) {
  return pluginAssetInputSchema.parse(input);
}
