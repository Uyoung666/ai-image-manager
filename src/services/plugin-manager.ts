import {
  createHash,
  createPublicKey,
  type KeyObject,
  randomUUID,
  verify as verifySignature,
} from "node:crypto";
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
  analyzeLocaleCoverage,
  canonicalizePluginSignatureEntries,
  compareSemVer,
  getLocalizedText,
  isValidSemVer,
  normalizePluginManifest,
  parsePluginManifestV1,
  parsePluginManifestV3Locale,
  parsePluginSignature,
  parsePluginTheme,
  validateLocaleBundle,
  validatePluginSettings,
} from "@/plugins/manifest";
import type {
  LocaleBundleValue,
  LocaleCoverage,
  NormalizedPluginManifest,
  NormalizedPluginManifestV2,
  NormalizedPluginManifestV3Locale,
  PluginManifestV1,
  PluginRecord,
  PluginRecordLocaleMetadata,
  PluginSettingDefinition,
  PluginSignature,
  PluginSnapshot,
} from "@/plugins/types";
import { createLogger } from "@/utils/logger";
import {
  type JsonValue,
  type PluginAssetRecord,
  type PluginInstallationRecord,
  PluginStore,
} from "./plugin-store";
import {
  deleteSetting,
  deleteSettingsByPrefix,
  getSetting,
  setSetting,
} from "./settings-manager";

const log = createLogger("plugin-manager");

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_COUNT = 256;
const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_LOCALE_BUNDLE_BYTES = 1024 * 1024;
const PLUGIN_ROOT = "plugins";
const PLUGIN_STAGING_ROOT = ".staging";
const PLUGIN_DATA_ROOT = "plugins-data";
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
const LOCALE_FILE_PATTERN = /^locales\/([^/]+)\/(renderer|main)\.json$/;
const LOCALE_DIRECTORY_PATTERN = /^locales(?:\/[^/]+)?$/;
const SIGNATURE_FILE = "signature.json";
const SIGNATURE_ALGORITHM = "ed25519" as const;
const SIGNATURE_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/**
 * Release builds must inject the independently managed official keyring. Keep
 * the source default empty so an unconfigured build never trusts a guessed or
 * development-only public key.
 */
export type PluginTrustedKeyring = Readonly<Record<string, string | KeyObject>>;
export const PLUGIN_TRUSTED_KEYS: PluginTrustedKeyring = Object.freeze({});
export const PLUGIN_TRUSTED_PUBLIC_KEYS = PLUGIN_TRUSTED_KEYS;

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

const pluginAssetInputSchema = z
  .object({
    pluginId: z.string().min(1).max(160),
    settingId: z.string().min(1).max(160),
  })
  .strict();

const pluginPatchSchema = z
  .object({
    pluginId: z.string().min(1).max(160),
    settings: z.record(
      z.string(),
      z.union([z.boolean(), z.number(), z.string(), z.null()])
    ),
  })
  .strict();

export type PluginManagerErrorCode =
  | "invalid-input"
  | "invalid-package"
  | "invalid-manifest"
  | "unsupported-version"
  | "builtin-conflict"
  | "same-version"
  | "downgrade"
  | "inspection-not-found"
  | "plugin-not-found"
  | "plugin-incompatible"
  | "plugin-invalid"
  | "containment"
  | "developer-mode-required"
  | "developer-plugin-not-found"
  | "database";

export class PluginManagerError extends Error {
  readonly code: PluginManagerErrorCode;

  constructor(code: PluginManagerErrorCode, message: string) {
    super(message.replace(PRIVATE_PATH_PATTERN, "<path>").slice(0, 240));
    this.name = "PluginManagerError";
    this.code = code;
  }
}

export interface PluginInstallPreview {
  capabilities: string[];
  checksum: string;
  compatible: boolean;
  currentVersion: string | null;
  kind: "install" | "update";
  locale?: PluginLocalePreview;
  manifest: NormalizedPluginManifest;
  packageBytes: number;
  pluginId: string;
  signed: boolean;
  signerKeyId?: string;
  source: "dialog";
  token: string;
  trust: PluginPackageTrust;
  version: string;
}

export type PluginPackageTrust = "developer" | "trusted" | "user-selected";

export interface PluginLocalePreview {
  catalogVersion: string;
  coverage: LocaleCoverage;
  mainFile: string;
  nativeName: string;
  rendererFile: string;
  signed: boolean;
  signerKeyId?: string;
  tag: string;
  trust: "developer" | "trusted";
}

export interface PluginLocaleCatalog {
  main?: LocaleBundleValue;
  renderer?: LocaleBundleValue;
}

export type LocaleCatalog = PluginLocaleCatalog;

export interface PluginLocaleProvider {
  catalogVersion: string;
  coverage: LocaleCoverage;
  main: LocaleBundleValue;
  nativeName: string;
  pluginId: string;
  renderer: LocaleBundleValue;
  signed: boolean;
  signerKeyId: string | null;
  tag: string;
  trust: "developer" | "trusted";
  version: string;
}

interface InspectionState {
  archivePath: string;
  preview: PluginInstallPreview;
  stagePath: string;
}

interface InstalledManifestEntry {
  diagnosticError?: string;
  directory?: string;
  error?: string;
  installation?: PluginInstallationRecord;
  manifest: NormalizedPluginManifest;
  origin?: "builtin" | "dev" | "local";
}

interface LocaleVerification {
  signed: boolean;
  signerKeyId?: string;
  trust: "developer" | "trusted";
}

type AnyPluginRecord = PluginRecord<NormalizedPluginManifest>;
type AnyPluginSnapshot = PluginSnapshot<NormalizedPluginManifest>;

function compareVersions(left: string, right: string): number {
  if (isValidSemVer(left) && isValidSemVer(right)) {
    return compareSemVer(left, right);
  }
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
    !normalized
      .split("/")
      .some((part) => part === "." || part === ".." || part.length === 0)
  );
}

function compareNames(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareManifestEntries(
  left: InstalledManifestEntry,
  right: InstalledManifestEntry
): number {
  return (
    compareNames(left.manifest.id, right.manifest.id) ||
    compareVersions(right.manifest.version, left.manifest.version)
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

function pluginResourceUrl(
  pluginId: string,
  versionOrRelativePath: string,
  maybeRelativePath?: string
): string {
  const version =
    maybeRelativePath === undefined ? null : versionOrRelativePath;
  const relativePath = maybeRelativePath ?? versionOrRelativePath;
  const encodedPath = relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const versionSegment = version ? `${encodeURIComponent(version)}/` : "";
  return `aim-plugin://${encodeURIComponent(pluginId)}/${versionSegment}${encodedPath}`;
}

function pluginStagingDirectory(): string {
  return path.join(pluginDirectory(), PLUGIN_STAGING_ROOT);
}

function pluginDataDirectory(pluginId?: string, settingId?: string): string {
  const root = path.join(app.getPath("userData"), PLUGIN_DATA_ROOT);
  if (!pluginId) {
    return root;
  }
  if (!settingId) {
    return path.join(root, pluginId);
  }
  return path.join(root, pluginId, settingId);
}

function sanitizePluginError(error: unknown): string {
  return safeErrorMessage(error);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}

function parseLocaleBundleFile(filePath: string): LocaleBundleValue {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > MAX_LOCALE_BUNDLE_BYTES) {
    throw new PluginManagerError("invalid-manifest", "语言包资源文件无效");
  }
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      fs.readFileSync(filePath)
    );
    value = JSON.parse(text) as unknown;
  } catch {
    throw new PluginManagerError("invalid-manifest", "语言包资源 JSON 无效");
  }
  try {
    return validateLocaleBundle(value);
  } catch (error) {
    throw new PluginManagerError(
      "invalid-manifest",
      sanitizePluginError(error)
    );
  }
}

function trustedKeyObject(value: string | KeyObject): KeyObject {
  let key: KeyObject;
  if (typeof value === "string") {
    key = value.includes("BEGIN PUBLIC KEY")
      ? createPublicKey(value)
      : createPublicKey({
          format: "der",
          key: Buffer.from(value, "base64"),
          type: "spki",
        });
  } else {
    key = value;
  }
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    throw new Error("trusted key must be an Ed25519 public key");
  }
  return key;
}

/**
 * Normalize a build-injected keyring once at startup. The function accepts
 * only public Ed25519 keys and returns a frozen, prototype-less map so a
 * signature key ID can never resolve through Object.prototype.
 */
export function createPluginTrustedKeyring(
  keys: Readonly<Record<string, string | KeyObject>>
): PluginTrustedKeyring {
  const normalized = Object.create(null) as Record<string, KeyObject>;
  for (const [keyId, value] of Object.entries(keys)) {
    if (!SIGNATURE_KEY_ID_PATTERN.test(keyId)) {
      throw new Error(`invalid trusted plugin key ID: ${keyId}`);
    }
    normalized[keyId] = trustedKeyObject(value);
  }
  return Object.freeze(normalized);
}

async function signatureFileEntries(
  directory: string
): Promise<Array<{ path: string; size: number; sha256: string }>> {
  const entries: Array<{ path: string; size: number; sha256: string }> = [];
  async function visit(current: string, relative = ""): Promise<void> {
    const children = await fsp.readdir(current, { withFileTypes: true });
    children.sort((left, right) => compareNames(left.name, right.name));
    for (const child of children) {
      const childRelative = relative ? `${relative}/${child.name}` : child.name;
      const normalized = childRelative.replaceAll("\\", "/");
      if (!isSafeRelativePath(normalized)) {
        throw new PluginManagerError("invalid-package", "插件包路径无效");
      }
      const childPath = path.join(current, child.name);
      const stat = await fsp.lstat(childPath);
      if (stat.isSymbolicLink()) {
        throw new PluginManagerError("invalid-package", "插件包不允许符号链接");
      }
      if (stat.isDirectory()) {
        await visit(childPath, normalized);
        continue;
      }
      if (!stat.isFile()) {
        throw new PluginManagerError("invalid-package", "插件包包含非普通文件");
      }
      if (normalized === SIGNATURE_FILE) {
        continue;
      }
      entries.push({
        path: normalized,
        sha256: await sha256File(childPath),
        size: stat.size,
      });
    }
  }
  await visit(directory);
  entries.sort((left, right) => compareNames(left.path, right.path));
  return entries;
}

async function verifyLocaleSignature(
  directory: string,
  trustedKeys: Readonly<Record<string, string | KeyObject>>,
  allowUnsigned: boolean
): Promise<LocaleVerification> {
  const signaturePath = path.join(directory, SIGNATURE_FILE);
  if (!fs.existsSync(signaturePath)) {
    if (allowUnsigned) {
      return { signed: false, trust: "developer" };
    }
    throw new PluginManagerError("invalid-package", "语言包缺少官方签名");
  }
  let signature: PluginSignature;
  try {
    signature = parsePluginSignature(readJson(signaturePath));
  } catch (error) {
    throw new PluginManagerError(
      "invalid-package",
      `语言包签名无效：${sanitizePluginError(error)}`
    );
  }
  if (signature.algorithm !== SIGNATURE_ALGORITHM) {
    throw new PluginManagerError("invalid-package", "语言包签名算法不受支持");
  }
  const keyValue = Object.hasOwn(trustedKeys, signature.keyId)
    ? trustedKeys[signature.keyId]
    : undefined;
  if (!keyValue) {
    throw new PluginManagerError(
      "invalid-package",
      "语言包签名者不在官方信任列表中"
    );
  }
  let key: KeyObject;
  let signatureBytes: Buffer;
  try {
    key = trustedKeyObject(keyValue);
    signatureBytes = Buffer.from(signature.signature, "base64");
  } catch {
    throw new PluginManagerError("invalid-package", "语言包签名密钥无效");
  }
  if (signatureBytes.length !== 64) {
    throw new PluginManagerError("invalid-package", "语言包签名长度无效");
  }
  const entries = await signatureFileEntries(directory);
  const canonical = canonicalizePluginSignatureEntries(entries);
  let valid = false;
  try {
    valid = verifySignature(
      null,
      Buffer.from(canonical, "utf8"),
      key,
      signatureBytes
    );
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new PluginManagerError("invalid-package", "语言包签名验证失败");
  }
  return { signed: true, signerKeyId: signature.keyId, trust: "trusted" };
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

function validateAnyPluginSettings(
  manifest: NormalizedPluginManifest,
  values: Record<string, unknown>
): Record<string, boolean | number | string | null> {
  if (manifest.manifestVersion === 1) {
    return validatePluginSettings(manifest as PluginManifestV1, values);
  }
  if (manifest.manifestVersion === 3) {
    return {};
  }
  return validatePluginSettings(manifest as NormalizedPluginManifestV2, values);
}

function readJson(filePath: string): unknown {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > MAX_JSON_BYTES) {
    throw new PluginManagerError("invalid-manifest", "插件 JSON 文件无效");
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      fs.readFileSync(filePath)
    );
    return JSON.parse(text) as unknown;
  } catch {
    throw new PluginManagerError("invalid-manifest", "插件 JSON 文件无效");
  }
}

function safeErrorMessage(error: unknown): string {
  let message = "unknown error";
  if (error instanceof Error || typeof error === "string") {
    message = typeof error === "string" ? error : error.message;
  }
  return message.replace(PRIVATE_PATH_PATTERN, "<path>").slice(0, 240);
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
  manifest: NormalizedPluginManifest,
  id: string
): (PluginSettingDefinition & { defaultValue?: unknown }) | undefined {
  if (manifest.manifestVersion === 3) {
    return undefined;
  }
  return manifest.settings.find((setting) => setting.id === id) as
    | (PluginSettingDefinition & { defaultValue?: unknown })
    | undefined;
}

function manifestAssetReferences(manifest: NormalizedPluginManifest): Array<{
  expectedType?: "image" | "video";
  lookupKey: string;
  settingId: string;
  relativePath: string;
}> {
  if (manifest.manifestVersion === 1) {
    const asset = manifest.theme.backdrop?.asset;
    return asset
      ? [
          {
            expectedType:
              manifest.theme.backdrop?.effect === "video" ? "video" : "image",
            lookupKey: "backdrop",
            relativePath: asset,
            settingId: "backdrop",
          },
        ]
      : [];
  }
  if (manifest.manifestVersion !== 2) {
    return [];
  }
  const references: Array<{
    expectedType?: "image" | "video";
    lookupKey: string;
    settingId: string;
    relativePath: string;
  }> = [];
  for (const layer of manifest.theme?.layers ?? []) {
    if (
      (layer.type === "image" || layer.type === "video") &&
      typeof layer.asset === "string"
    ) {
      references.push({
        expectedType: layer.type,
        lookupKey: layer.asset,
        relativePath: layer.asset,
        settingId: layer.id,
      });
    }
  }
  return references;
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
          if (entry.isEncrypted()) {
            fail(new Error("插件包不允许加密条目"));
            return;
          }
          if (isDirectory) {
            if (
              entryName !== "assets" &&
              !entryName.startsWith("assets/") &&
              !LOCALE_DIRECTORY_PATTERN.test(entryName)
            ) {
              fail(new Error("插件包包含不允许的目录"));
              return;
            }
            zipFile.readEntry();
            return;
          }
          const isManifest =
            entryName === "plugin.json" ||
            entryName === "theme.json" ||
            entryName === SIGNATURE_FILE;
          const isLocaleBundle = LOCALE_FILE_PATTERN.test(entryName);
          const extension = path.extname(entryName).toLowerCase();
          const isAsset = entryName.startsWith("assets/");
          if (
            !(
              isManifest ||
              isLocaleBundle ||
              (isAsset && ALLOWED_ASSET_EXTENSIONS.has(extension))
            )
          ) {
            fail(new Error(`插件包包含不允许的文件：${entryName}`));
            return;
          }
          if (
            entry.uncompressedSize > MAX_EXTRACTED_BYTES ||
            ((isManifest || isLocaleBundle) &&
              entry.uncompressedSize > MAX_LOCALE_BUNDLE_BYTES) ||
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
                const maxEntryBytes =
                  isManifest || isLocaleBundle
                    ? MAX_LOCALE_BUNDLE_BYTES
                    : MAX_ASSET_BYTES;
                stream.on("data", (chunk: Buffer) => {
                  bytes += chunk.length;
                  extracted += chunk.length;
                  if (
                    bytes > maxEntryBytes ||
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

/** Validate the complete on-disk package layout after extraction. */
async function validatePackageLayout(
  directory: string,
  manifest: NormalizedPluginManifest,
  allowUnsignedLocale: boolean
): Promise<void> {
  const files = new Set<string>();
  const fileKeys = new Set<string>();
  const isLocale = manifest.manifestVersion === 3;
  const localeManifest = isLocale
    ? (manifest as NormalizedPluginManifestV3Locale)
    : undefined;
  const localeTag = localeManifest?.locale.tag;
  const expectedLocaleFiles = localeManifest
    ? new Set([
        localeManifest.locale.rendererFile,
        localeManifest.locale.mainFile,
      ])
    : new Set<string>();

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: package layout validation is a deliberate security boundary.
  async function visit(current: string, relative = ""): Promise<void> {
    const children = await fsp.readdir(current, { withFileTypes: true });
    children.sort((left, right) => compareNames(left.name, right.name));
    for (const child of children) {
      const childRelative = relative ? `${relative}/${child.name}` : child.name;
      const normalized = childRelative.replaceAll("\\", "/");
      if (!isSafeRelativePath(normalized)) {
        throw new PluginManagerError("invalid-package", "插件包路径无效");
      }
      const childPath = path.join(current, child.name);
      const stat = await fsp.lstat(childPath);
      if (stat.isSymbolicLink()) {
        throw new PluginManagerError("invalid-package", "插件包不允许符号链接");
      }
      if (stat.isDirectory()) {
        const directoryAllowed = isLocale
          ? normalized === "locales" || normalized === `locales/${localeTag}`
          : normalized === "assets" || normalized.startsWith("assets/");
        if (!directoryAllowed) {
          throw new PluginManagerError(
            "invalid-package",
            `插件包包含不允许的目录：${normalized}`
          );
        }
        await visit(childPath, normalized);
        continue;
      }
      if (!stat.isFile()) {
        throw new PluginManagerError(
          "invalid-package",
          `插件包包含非普通文件：${normalized}`
        );
      }
      const fileKey = normalized.toLowerCase();
      if (fileKeys.has(fileKey)) {
        throw new PluginManagerError(
          "invalid-package",
          `插件包包含重复文件：${normalized}`
        );
      }
      fileKeys.add(fileKey);
      files.add(normalized);
      if (isLocale) {
        if (normalized === "plugin.json" || normalized === SIGNATURE_FILE) {
          if (normalized === SIGNATURE_FILE && stat.size > MAX_JSON_BYTES) {
            throw new PluginManagerError(
              "invalid-package",
              "签名文件超过大小限制"
            );
          }
          continue;
        }
        if (!expectedLocaleFiles.has(normalized)) {
          throw new PluginManagerError(
            "invalid-package",
            `语言包包含不允许的文件：${normalized}`
          );
        }
        if (stat.size > MAX_LOCALE_BUNDLE_BYTES) {
          throw new PluginManagerError(
            "invalid-package",
            "语言包资源超过大小限制"
          );
        }
        parseLocaleBundleFile(childPath);
        continue;
      }
      const isThemeFile = normalized === "theme.json";
      const isAsset = normalized.startsWith("assets/");
      if (
        normalized !== "plugin.json" &&
        !isThemeFile &&
        !(
          isAsset &&
          ALLOWED_ASSET_EXTENSIONS.has(path.extname(normalized).toLowerCase())
        )
      ) {
        throw new PluginManagerError(
          "invalid-package",
          `插件包包含不允许的文件：${normalized}`
        );
      }
      if (isThemeFile && stat.size > MAX_JSON_BYTES) {
        throw new PluginManagerError("invalid-package", "主题文件超过大小限制");
      }
      if (isAsset) {
        try {
          await detectAssetKind(
            childPath,
            path.extname(normalized).toLowerCase()
          );
        } catch (error) {
          throw new PluginManagerError(
            "invalid-package",
            `插件资源无效：${sanitizePluginError(error)}`
          );
        }
      }
    }
  }

  await visit(directory);
  if (!files.has("plugin.json")) {
    throw new PluginManagerError("invalid-package", "插件包缺少 plugin.json");
  }
  if (isLocale) {
    for (const expected of expectedLocaleFiles) {
      if (!files.has(expected)) {
        throw new PluginManagerError(
          "invalid-package",
          `语言包缺少资源文件：${expected}`
        );
      }
    }
    if (!(files.has(SIGNATURE_FILE) || allowUnsignedLocale)) {
      throw new PluginManagerError("invalid-package", "语言包缺少官方签名");
    }
  }
}

function appCompatible(manifest: NormalizedPluginManifest): boolean {
  return compareVersions(app.getVersion(), manifest.engine.minAppVersion) >= 0;
}

function readInstalledManifest(directory: string): NormalizedPluginManifest {
  const rawManifest = readJson(path.join(directory, "plugin.json"));
  if (
    typeof rawManifest !== "object" ||
    rawManifest === null ||
    !("manifestVersion" in rawManifest)
  ) {
    throw new PluginManagerError("invalid-manifest", "插件清单无效");
  }
  const raw = rawManifest as {
    apiVersion?: unknown;
    manifestVersion?: unknown;
    themeFile?: unknown;
  };
  if (raw.manifestVersion === 3 || raw.apiVersion === 3) {
    return parsePluginManifestV3Locale(rawManifest);
  }
  if (raw.manifestVersion === 2) {
    const themeFile = raw.themeFile;
    if (themeFile !== "theme.json") {
      throw new PluginManagerError("invalid-manifest", "v2 插件主题文件无效");
    }
    const themePath = path.join(directory, "theme.json");
    if (!(isContained(themePath, directory) && fs.existsSync(themePath))) {
      throw new PluginManagerError("invalid-manifest", "插件主题文件不存在");
    }
    return normalizePluginManifest(rawManifest, readJson(themePath));
  }
  const manifest = parsePluginManifestV1(rawManifest);
  if (manifest.themeFile) {
    const themePath = path.join(directory, manifest.themeFile);
    if (!(isContained(themePath, directory) && fs.existsSync(themePath))) {
      throw new Error("插件主题文件不存在");
    }
    manifest.theme = parsePluginTheme(readJson(themePath));
  }
  return manifest;
}

async function validateManifestResources(
  directory: string,
  manifest: NormalizedPluginManifest
): Promise<void> {
  const references = [...manifestAssetReferences(manifest)];
  if (manifest.manifestVersion === 2 && manifest.icon) {
    references.push({
      lookupKey: manifest.icon,
      relativePath: manifest.icon,
      settingId: manifest.icon,
    });
  }
  for (const { expectedType, relativePath } of references) {
    if (
      !(isSafeRelativePath(relativePath) && relativePath.startsWith("assets/"))
    ) {
      throw new PluginManagerError("invalid-manifest", "插件资源路径无效");
    }
    const assetPath = path.resolve(directory, relativePath);
    if (!(isContained(assetPath, directory) && fs.existsSync(assetPath))) {
      throw new PluginManagerError("invalid-manifest", "插件资源文件不存在");
    }
    try {
      const [realDirectory, realAsset] = await Promise.all([
        fsp.realpath(directory),
        fsp.realpath(assetPath),
      ]);
      if (!isContained(realAsset, realDirectory)) {
        throw new Error("插件资源链接越界");
      }
      const detected = await detectAssetKind(
        assetPath,
        path.extname(assetPath).toLowerCase()
      );
      if (expectedType && detected !== expectedType) {
        throw new Error("插件资源类型与主题层不匹配");
      }
    } catch (error) {
      throw new PluginManagerError(
        "invalid-manifest",
        `插件资源无效：${sanitizePluginError(error)}`
      );
    }
  }
}

function combineLocaleCoverage(
  renderer: LocaleCoverage,
  main: LocaleCoverage
): LocaleCoverage {
  const available = renderer.available || main.available;
  const total = renderer.total + main.total;
  const translated = renderer.translated + main.translated;
  let percentage: number | null = null;
  if (available) {
    percentage = total > 0 ? (translated / total) * 100 : 100;
  }
  return {
    available,
    extra: [
      ...renderer.extra.map((key) => `renderer.${key}`),
      ...main.extra.map((key) => `main.${key}`),
    ],
    missing: [
      ...renderer.missing.map((key) => `renderer.${key}`),
      ...main.missing.map((key) => `main.${key}`),
    ],
    placeholderMismatches: [
      ...renderer.placeholderMismatches.map((key) => `renderer.${key}`),
      ...main.placeholderMismatches.map((key) => `main.${key}`),
    ],
    percentage,
    total,
    translated,
  };
}

async function loadLocaleProviderFromDirectory(
  directory: string,
  manifest: NormalizedPluginManifestV3Locale,
  verification: LocaleVerification,
  catalog?: PluginLocaleCatalog
): Promise<PluginLocaleProvider> {
  const files = [manifest.locale.rendererFile, manifest.locale.mainFile];
  const bundles: LocaleBundleValue[] = [];
  for (const relative of files) {
    if (
      !(
        isSafeRelativePath(relative) &&
        relative.startsWith(`locales/${manifest.locale.tag}/`)
      )
    ) {
      throw new PluginManagerError("invalid-manifest", "语言包资源路径无效");
    }
    const filePath = path.resolve(directory, relative);
    if (!(isContained(filePath, directory) && fs.existsSync(filePath))) {
      throw new PluginManagerError("invalid-manifest", "语言包资源文件不存在");
    }
    try {
      const [realDirectory, realFile] = await Promise.all([
        fsp.realpath(directory),
        fsp.realpath(filePath),
      ]);
      if (!isContained(realFile, realDirectory)) {
        throw new Error("语言包资源链接越界");
      }
    } catch (error) {
      throw new PluginManagerError(
        "invalid-manifest",
        `语言包资源无效：${sanitizePluginError(error)}`
      );
    }
    bundles.push(parseLocaleBundleFile(filePath));
  }
  const renderer = bundles[0] as LocaleBundleValue;
  const main = bundles[1] as LocaleBundleValue;
  const coverage = combineLocaleCoverage(
    analyzeLocaleCoverage(renderer, catalog?.renderer),
    analyzeLocaleCoverage(main, catalog?.main)
  );
  return {
    catalogVersion: manifest.locale.catalogVersion,
    coverage,
    main,
    nativeName: manifest.locale.nativeName,
    pluginId: manifest.id,
    renderer,
    signed: verification.signed,
    signerKeyId: verification.signerKeyId ?? null,
    tag: manifest.locale.tag,
    trust: verification.trust,
    version: manifest.version,
  };
}

export class PluginManager {
  private readonly builtins: NormalizedPluginManifest[];
  private readonly trustedKeys: PluginTrustedKeyring;
  private store: PluginStore | null | undefined;
  private readonly inspections = new Map<string, InspectionState>();
  private readonly devPlugins = new Map<string, InstalledManifestEntry>();
  private developerMode = false;
  private rootReady: Promise<void> | undefined;

  constructor(
    builtins: NormalizedPluginManifest[],
    store?: PluginStore,
    trustedKeys: Readonly<
      Record<string, string | KeyObject>
    > = PLUGIN_TRUSTED_KEYS
  ) {
    this.builtins = builtins;
    this.store = store;
    this.trustedKeys = createPluginTrustedKeyring(trustedKeys);
  }

  private optionalStore(): PluginStore | null {
    if (this.store !== undefined) {
      return this.store;
    }
    try {
      this.store = new PluginStore();
    } catch (error) {
      // Unit tests and older installations may not have a migrated database;
      // retain the legacy settings path until the store can be initialized.
      log.debug(
        { error: sanitizePluginError(error) },
        "plugin store unavailable"
      );
      this.store = null;
    }
    return this.store;
  }

  private requiredStore(): PluginStore {
    const store = this.optionalStore();
    if (!store) {
      throw new PluginManagerError("database", "插件存储不可用");
    }
    return store;
  }

  private tryStore<T>(callback: (store: PluginStore) => T, fallback: T): T {
    const store = this.optionalStore();
    if (!store) {
      return fallback;
    }
    try {
      return callback(store);
    } catch (error) {
      log.debug(
        { error: sanitizePluginError(error) },
        "plugin store operation skipped"
      );
      return fallback;
    }
  }

  private async cleanupManagedAssets(
    pluginId: string,
    assets: PluginAssetRecord[]
  ): Promise<void> {
    for (const asset of assets) {
      const managedPath = path.isAbsolute(asset.managedPath)
        ? asset.managedPath
        : path.resolve(app.getPath("userData"), asset.managedPath);
      if (!isContained(managedPath, pluginDataDirectory(pluginId))) {
        continue;
      }
      try {
        await fsp.rm(managedPath, { force: true });
      } catch (error) {
        log.warn(
          {
            error: sanitizePluginError(error),
            pluginId,
            settingId: asset.settingId,
          },
          "managed plugin asset cleanup failed"
        );
      }
    }
  }

  async ensureRoot(): Promise<void> {
    this.rootReady ??= (async () => {
      await fsp.mkdir(pluginDirectory(), { recursive: true });
      const staging = pluginStagingDirectory();
      if (
        !(isContained(staging, pluginDirectory()) && fs.existsSync(staging))
      ) {
        return;
      }
      try {
        await fsp.rm(staging, { force: true, recursive: true });
      } catch (error) {
        log.warn(
          { error: sanitizePluginError(error) },
          "stale plugin staging cleanup failed"
        );
      }
    })();
    await this.rootReady;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: each package entry is independently validated and diagnosed.
  private async installedManifests(
    options: { migrate?: boolean } = { migrate: false }
  ): Promise<InstalledManifestEntry[]> {
    await this.ensureRoot();
    const results: InstalledManifestEntry[] = [];
    for (const idEntry of await fsp.readdir(pluginDirectory(), {
      withFileTypes: true,
    })) {
      if (!idEntry.isDirectory()) {
        continue;
      }
      if (
        idEntry.name === PLUGIN_STAGING_ROOT ||
        idEntry.name.startsWith(".")
      ) {
        continue;
      }
      const idDirectory = path.join(pluginDirectory(), idEntry.name);
      for (const versionEntry of await fsp.readdir(idDirectory, {
        withFileTypes: true,
      })) {
        if (!versionEntry.isDirectory()) {
          continue;
        }
        if (versionEntry.name.startsWith(".")) {
          continue;
        }
        const directory = path.join(idDirectory, versionEntry.name);
        try {
          const manifest = await readInstalledManifest(directory);
          const installation = this.tryStore(
            (store) => store.getInstallation(manifest.id, manifest.version),
            null
          );
          const allowUnsignedLocale =
            manifest.manifestVersion === 3 &&
            this.developerMode &&
            installation?.origin === "dev";
          await validatePackageLayout(directory, manifest, allowUnsignedLocale);
          await validateManifestResources(directory, manifest);
          if (manifest.manifestVersion === 3) {
            await verifyLocaleSignature(
              directory,
              this.trustedKeys,
              allowUnsignedLocale
            );
          }
          results.push({
            directory,
            installation: installation ?? undefined,
            manifest,
            origin: installation?.origin === "dev" ? "dev" : "local",
          });
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
    if (options.migrate) {
      await this.migrateLegacySettings(results);
    }
    return results;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: record assembly intentionally combines legacy and v2 persistence fallbacks.
  private async recordFor(
    manifest: NormalizedPluginManifest,
    source: "builtin" | "local" | "dev",
    directory?: string,
    error?: string,
    installation?: PluginInstallationRecord,
    diagnosticError?: string
  ): Promise<AnyPluginRecord> {
    const store = this.optionalStore();
    const preference = this.tryStore(
      (store) => store.getPreference(manifest.id),
      null
    );
    let rawSettings: unknown = preference?.settings;
    if (
      manifest.manifestVersion !== 3 &&
      !(
        (rawSettings &&
          typeof rawSettings === "object" &&
          !Array.isArray(rawSettings)) ||
        store
      )
    ) {
      const value = getSetting(pluginSettingsKey(manifest.id));
      if (value) {
        try {
          rawSettings = JSON.parse(value) as Record<string, unknown>;
        } catch {
          rawSettings = {};
        }
      }
    }
    let parsedSettings: Record<string, unknown> = {};
    if (
      rawSettings &&
      typeof rawSettings === "object" &&
      !Array.isArray(rawSettings)
    ) {
      parsedSettings = rawSettings as Record<string, unknown>;
    }
    let settings: Record<string, boolean | number | string | null>;
    if (manifest.manifestVersion === 3) {
      settings = {};
    } else if (manifest.manifestVersion === 1 && !store) {
      settings = normalizePluginSettings(
        manifest,
        source === "builtin" ? "builtin" : "local",
        parsedSettings
      );
    } else {
      settings = validateAnyPluginSettings(manifest, parsedSettings);
    }
    const activePluginId = this.tryStore(
      (store) => store.getActivePluginId(),
      null
    );
    let enabled = false;
    if (manifest.manifestVersion !== 3) {
      enabled = activePluginId
        ? activePluginId === manifest.id
        : !store && getSetting(pluginEnabledKey(manifest.id)) === "true";
    }
    const compatible = appCompatible(manifest);
    const assetUrls: Record<string, string> = {};
    for (const setting of manifest.manifestVersion === 2 ||
    manifest.manifestVersion === 1
      ? manifest.settings
      : []) {
      if (setting.type !== "image" && setting.type !== "video") {
        continue;
      }
      const managedAsset = this.tryStore(
        (store) => store.getAsset(manifest.id, setting.id),
        null
      );
      if (managedAsset) {
        assetUrls[setting.id] = userAssetUrl(
          manifest.id,
          setting.id,
          managedAsset.revision
        );
      } else if (
        !store &&
        getSetting(pluginAssetKey(manifest.id, setting.id))
      ) {
        assetUrls[setting.id] = userAssetUrl(
          manifest.id,
          setting.id,
          getSetting(pluginAssetRevisionKey(manifest.id, setting.id))
        );
      }
    }
    if (directory) {
      for (const { lookupKey, relativePath } of manifestAssetReferences(
        manifest
      )) {
        const relativeAsset = relativePath;
        if (!isSafeRelativePath(relativeAsset)) {
          continue;
        }
        const assetPath = path.resolve(directory, relativeAsset);
        if (
          isContained(assetPath, directory) &&
          relativeAsset.startsWith("assets/") &&
          fs.existsSync(assetPath)
        ) {
          assetUrls[lookupKey] = pluginResourceUrl(
            manifest.id,
            installation?.version ?? manifest.version,
            relativeAsset
          );
        }
      }
      if (
        manifest.manifestVersion === 2 &&
        manifest.icon &&
        isSafeRelativePath(manifest.icon) &&
        manifest.icon.startsWith("assets/")
      ) {
        const iconPath = path.resolve(directory, manifest.icon);
        if (isContained(iconPath, directory) && fs.existsSync(iconPath)) {
          assetUrls[manifest.icon] = pluginResourceUrl(
            manifest.id,
            installation?.version ?? manifest.version,
            manifest.icon
          );
        }
      }
    }
    let locale: PluginRecordLocaleMetadata | undefined;
    let localeValidationError: string | undefined;
    if (manifest.manifestVersion === 3 && directory) {
      try {
        const localeManifest = manifest as NormalizedPluginManifestV3Locale;
        const allowUnsigned = source === "dev" && this.developerMode;
        await validatePackageLayout(directory, localeManifest, allowUnsigned);
        await validateManifestResources(directory, localeManifest);
        const verification = await verifyLocaleSignature(
          directory,
          this.trustedKeys,
          allowUnsigned
        );
        const provider = await loadLocaleProviderFromDirectory(
          directory,
          localeManifest,
          verification
        );
        locale = {
          catalogVersion: provider.catalogVersion,
          coverage: provider.coverage,
          nativeName: provider.nativeName,
          signed: provider.signed,
          ...(provider.signerKeyId
            ? { signerKeyId: provider.signerKeyId }
            : {}),
          tag: provider.tag,
          trust: provider.trust,
        };
      } catch (validationError) {
        localeValidationError = sanitizePluginError(validationError);
      }
    }
    const hasDirectory = source === "builtin" || Boolean(directory);
    const installationFailed = installation?.status === "failed";
    const recordError =
      error ??
      diagnosticError ??
      installation?.lastErrorDetail ??
      installation?.lastErrorCode ??
      localeValidationError ??
      undefined;
    let status: AnyPluginRecord["status"] = "disabled";
    if (error || localeValidationError) {
      status = "invalid";
    } else if (installationFailed) {
      status = "failed";
    } else if (!compatible) {
      status = "incompatible";
    } else if (enabled && hasDirectory) {
      status = "active";
    }
    return {
      assetUrls,
      enabled: enabled && compatible && hasDirectory && !installationFailed,
      error: recordError ? sanitizePluginError(recordError) : undefined,
      locale,
      manifest,
      settings,
      source,
      status,
    } as AnyPluginRecord;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: migration validates and copies each legacy asset independently.
  private async migrateLegacySettings(
    manifests: InstalledManifestEntry[]
  ): Promise<void> {
    const store = this.optionalStore();
    if (!store) {
      return;
    }
    let candidates: ReturnType<PluginStore["listLegacyMigrationCandidates"]>;
    try {
      candidates = store.listLegacyMigrationCandidates();
    } catch (error) {
      log.debug(
        { error: sanitizePluginError(error) },
        "legacy plugin migration unavailable"
      );
      return;
    }
    const byId = new Map<string, InstalledManifestEntry>();
    for (const item of manifests) {
      if (!byId.has(item.manifest.id)) {
        byId.set(item.manifest.id, item);
      }
    }
    for (const builtin of this.builtins) {
      if (!byId.has(builtin.id)) {
        byId.set(builtin.id, { manifest: builtin, origin: "builtin" });
      }
    }
    for (const candidate of candidates) {
      const item = byId.get(candidate.pluginId);
      if (!item || item.error) {
        continue;
      }
      try {
        const raw =
          candidate.settings &&
          typeof candidate.settings === "object" &&
          !Array.isArray(candidate.settings)
            ? (candidate.settings as Record<string, unknown>)
            : {};
        const settings = validateAnyPluginSettings(item.manifest, raw);
        const selectedVersion = item.manifest.version;
        const previous = store.getPreference(candidate.pluginId);
        store.upsertPreference({
          lastKnownGoodVersion:
            previous?.lastKnownGoodVersion ?? selectedVersion,
          pluginId: candidate.pluginId,
          selectedVersion: previous?.selectedVersion ?? selectedVersion,
          settings,
          settingsSchemaVersion: previous?.settingsSchemaVersion ?? 1,
        });
        let assetSettingsMigrated = false;
        for (const asset of candidate.assets) {
          if (
            !(
              asset.managedPath &&
              path.isAbsolute(asset.managedPath) &&
              fs.existsSync(asset.managedPath)
            )
          ) {
            continue;
          }
          const definition = settingFor(item.manifest, asset.settingId);
          if (
            !definition ||
            (definition.type !== "image" && definition.type !== "video")
          ) {
            continue;
          }
          const extension = path.extname(asset.managedPath).toLowerCase();
          const detected = await detectAssetKind(asset.managedPath, extension);
          if (detected !== definition.type) {
            continue;
          }
          const managedDirectory = pluginDataDirectory(
            candidate.pluginId,
            asset.settingId
          );
          await fsp.mkdir(managedDirectory, { recursive: true });
          const managedPath = path.join(
            managedDirectory,
            `${randomUUID()}${extension}`
          );
          await fsp.copyFile(asset.managedPath, managedPath);
          const stat = await fsp.stat(managedPath);
          const revision = asset.revision ?? randomUUID();
          store.upsertAsset({
            byteSize: stat.size,
            managedPath,
            mimeType: mimeTypes[extension] ?? "application/octet-stream",
            pluginId: candidate.pluginId,
            revision,
            settingId: asset.settingId,
          });
          settings[asset.settingId] = revision;
          assetSettingsMigrated = true;
        }
        if (assetSettingsMigrated) {
          store.upsertPreference({
            lastKnownGoodVersion:
              previous?.lastKnownGoodVersion ?? selectedVersion,
            pluginId: candidate.pluginId,
            selectedVersion: previous?.selectedVersion ?? selectedVersion,
            settings,
            settingsSchemaVersion: previous?.settingsSchemaVersion ?? 1,
          });
        }
        if (candidate.enabled === true) {
          store.setActivePluginId(candidate.pluginId);
        }
        store.clearLegacyMigrationCandidate(candidate);
      } catch (error) {
        log.warn(
          { pluginId: candidate.pluginId, error: sanitizePluginError(error) },
          "legacy plugin migration failed"
        );
      }
    }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: listing merges persisted, legacy, builtin and developer records.
  async list(): Promise<AnyPluginSnapshot> {
    const installed = await this.installedManifests({ migrate: true });
    const allInstalled = [...installed];
    if (this.developerMode) {
      for (const entry of this.devPlugins.values()) {
        allInstalled.push(entry);
      }
    }
    const installedById = new Map<string, InstalledManifestEntry>();
    const groupedInstalled = new Map<string, InstalledManifestEntry[]>();
    for (const item of allInstalled) {
      const group = groupedInstalled.get(item.manifest.id) ?? [];
      group.push(item);
      groupedInstalled.set(item.manifest.id, group);
    }
    for (const [pluginId, group] of groupedInstalled) {
      const developerEntry = this.developerMode
        ? this.devPlugins.get(pluginId)
        : undefined;
      if (developerEntry) {
        installedById.set(pluginId, developerEntry);
        continue;
      }
      const selectedVersion = this.tryStore(
        (store) => store.getPreference(pluginId)?.selectedVersion,
        null
      );
      const selected = selectedVersion
        ? group.find((item) => item.manifest.version === selectedVersion)
        : undefined;
      const fallback = group.sort((left, right) =>
        compareVersions(right.manifest.version, left.manifest.version)
      )[0];
      const chosen = selected ?? fallback;
      if (chosen) {
        const failed = group
          .filter((item) => item.installation?.status === "failed")
          .sort((left, right) =>
            compareVersions(right.manifest.version, left.manifest.version)
          )[0];
        installedById.set(
          pluginId,
          failed && failed.manifest.version !== chosen.manifest.version
            ? {
                ...chosen,
                diagnosticError:
                  failed.installation?.lastErrorDetail ??
                  failed.installation?.lastErrorCode ??
                  "插件更新已回滚",
              }
            : chosen
        );
      }
    }
    const records: AnyPluginRecord[] = [];
    for (const manifest of this.builtins) {
      records.push(await this.recordFor(manifest, "builtin"));
    }
    for (const {
      directory,
      diagnosticError,
      error,
      manifest,
      origin,
      installation,
    } of installedById.values()) {
      if (this.builtins.some((builtin) => builtin.id === manifest.id)) {
        continue;
      }
      records.push(
        await this.recordFor(
          manifest,
          origin === "dev" ? "dev" : "local",
          directory,
          error,
          installation,
          diagnosticError
        )
      );
    }
    return { plugins: records };
  }

  private async localeEntries(
    allVersions = false
  ): Promise<InstalledManifestEntry[]> {
    const installed = (
      await this.installedManifests({ migrate: false })
    ).filter(
      (entry) => entry.manifest.manifestVersion === 3 && entry.directory
    );
    const candidates = [...installed];
    if (this.developerMode) {
      for (const entry of this.devPlugins.values()) {
        if (entry.manifest.manifestVersion === 3 && entry.directory) {
          candidates.push(entry);
        }
      }
    }
    if (allVersions) {
      return candidates.sort(compareManifestEntries);
    }
    const byId = new Map<string, InstalledManifestEntry>();
    for (const entry of candidates) {
      const existing = byId.get(entry.manifest.id);
      if (
        !existing ||
        compareVersions(entry.manifest.version, existing.manifest.version) >
          0 ||
        (entry.origin === "dev" &&
          entry.manifest.version === existing.manifest.version)
      ) {
        byId.set(entry.manifest.id, entry);
      }
    }
    return [...byId.values()].sort(compareManifestEntries);
  }

  /** List safe locale providers without exposing package directories. */
  async listLocaleProviders(
    catalog?: PluginLocaleCatalog
  ): Promise<PluginLocaleProvider[]> {
    const providers: PluginLocaleProvider[] = [];
    for (const entry of await this.localeEntries()) {
      if (!entry.directory) {
        continue;
      }
      try {
        const manifest = entry.manifest as NormalizedPluginManifestV3Locale;
        if (!appCompatible(manifest)) {
          continue;
        }
        const allowUnsigned = entry.origin === "dev" && this.developerMode;
        await validatePackageLayout(entry.directory, manifest, allowUnsigned);
        await validateManifestResources(entry.directory, manifest);
        const verification = await verifyLocaleSignature(
          entry.directory,
          this.trustedKeys,
          allowUnsigned
        );
        providers.push(
          await loadLocaleProviderFromDirectory(
            entry.directory,
            manifest,
            verification,
            catalog
          )
        );
      } catch (error) {
        log.warn(
          {
            error: sanitizePluginError(error),
            pluginId: entry.manifest.id,
          },
          "locale provider validation failed"
        );
      }
    }
    return providers;
  }

  /** Load one validated locale provider by ID and optional version. */
  async loadLocaleProvider(
    pluginId: string,
    version?: string,
    catalog?: PluginLocaleCatalog
  ): Promise<PluginLocaleProvider> {
    if (!PLUGIN_ID_PATTERN.test(pluginId)) {
      throw new PluginManagerError("invalid-input", "语言包 ID 无效");
    }
    if (version !== undefined && !isValidSemVer(version)) {
      throw new PluginManagerError("invalid-input", "语言包版本无效");
    }
    const entries = (await this.localeEntries(version !== undefined)).filter(
      (entry) =>
        entry.manifest.id === pluginId &&
        (version === undefined || entry.manifest.version === version)
    );
    const entry = entries.sort((left, right) =>
      compareVersions(right.manifest.version, left.manifest.version)
    )[0];
    if (!entry?.directory) {
      throw new PluginManagerError("plugin-not-found", "语言包不存在");
    }
    const manifest = entry.manifest as NormalizedPluginManifestV3Locale;
    if (!appCompatible(manifest)) {
      throw new PluginManagerError(
        "plugin-incompatible",
        "语言包与当前应用不兼容"
      );
    }
    const allowUnsigned = entry.origin === "dev" && this.developerMode;
    await validatePackageLayout(entry.directory, manifest, allowUnsigned);
    await validateManifestResources(entry.directory, manifest);
    const verification = await verifyLocaleSignature(
      entry.directory,
      this.trustedKeys,
      allowUnsigned
    );
    return loadLocaleProviderFromDirectory(
      entry.directory,
      manifest,
      verification,
      catalog
    );
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: staged package inspection is a deliberate security boundary.
  private async inspectStagedPlugin(
    archivePath: string,
    stagePath: string
  ): Promise<PluginInstallPreview> {
    let manifest: NormalizedPluginManifest;
    let verification: LocaleVerification | undefined;
    try {
      manifest = readInstalledManifest(stagePath);
      await validatePackageLayout(stagePath, manifest, false);
      await validateManifestResources(stagePath, manifest);
      if (manifest.manifestVersion === 3) {
        verification = await verifyLocaleSignature(
          stagePath,
          this.trustedKeys,
          false
        );
      }
    } catch (error) {
      if (error instanceof PluginManagerError) {
        throw error;
      }
      throw new PluginManagerError(
        "invalid-manifest",
        sanitizePluginError(error)
      );
    }
    if (!PLUGIN_ID_PATTERN.test(manifest.id)) {
      throw new PluginManagerError("invalid-manifest", "插件 ID 无效");
    }
    if (!isValidSemVer(manifest.version)) {
      throw new PluginManagerError(
        "unsupported-version",
        "插件版本必须是 SemVer"
      );
    }
    if (this.builtins.some((builtin) => builtin.id === manifest.id)) {
      throw new PluginManagerError(
        "builtin-conflict",
        "插件 ID 与内置插件冲突"
      );
    }
    const installed = await this.installedManifests();
    const sameId = installed.filter((item) => item.manifest.id === manifest.id);
    const persisted = this.tryStore(
      (store) => store.listInstallations(manifest.id),
      []
    );
    if (
      sameId.some((item) => item.manifest.version === manifest.version) ||
      persisted.some((item) => item.version === manifest.version)
    ) {
      throw new PluginManagerError("same-version", "相同版本插件已安装");
    }
    const current = [...sameId].sort((left, right) =>
      compareVersions(right.manifest.version, left.manifest.version)
    )[0];
    const persistedCurrent = [...persisted].sort((left, right) =>
      compareVersions(right.version, left.version)
    )[0];
    const currentVersion =
      current?.manifest.version ?? persistedCurrent?.version;
    if (
      currentVersion &&
      compareVersions(manifest.version, currentVersion) < 0
    ) {
      throw new PluginManagerError("downgrade", "正式插件包不允许降级");
    }
    const target = path.join(pluginDirectory(), manifest.id, manifest.version);
    if (!isContained(target, pluginDirectory())) {
      throw new PluginManagerError("containment", "插件安装路径非法");
    }
    if (fs.existsSync(target)) {
      throw new PluginManagerError("same-version", "相同版本插件已安装");
    }
    const archiveStat = await fsp.stat(archivePath);
    const localeManifest =
      manifest.manifestVersion === 3
        ? (manifest as NormalizedPluginManifestV3Locale)
        : undefined;
    const locale =
      localeManifest && verification
        ? await loadLocaleProviderFromDirectory(
            stagePath,
            localeManifest,
            verification
          )
        : undefined;
    return {
      capabilities: [...manifest.capabilities],
      checksum: await sha256File(archivePath),
      compatible: appCompatible(manifest),
      currentVersion: currentVersion ?? null,
      kind: currentVersion ? "update" : "install",
      locale: locale
        ? {
            catalogVersion: locale.catalogVersion,
            coverage: locale.coverage,
            mainFile: localeManifest?.locale.mainFile ?? "",
            nativeName: locale.nativeName,
            rendererFile: localeManifest?.locale.rendererFile ?? "",
            signed: locale.signed,
            ...(locale.signerKeyId ? { signerKeyId: locale.signerKeyId } : {}),
            tag: locale.tag,
            trust: locale.trust,
          }
        : undefined,
      manifest,
      packageBytes: archiveStat.size,
      pluginId: manifest.id,
      signed: verification?.signed ?? false,
      ...(verification?.signerKeyId
        ? { signerKeyId: verification.signerKeyId }
        : {}),
      source: "dialog",
      token: path.basename(stagePath),
      trust: verification?.trust ?? "user-selected",
      version: manifest.version,
    };
  }

  async inspectFromDialog(): Promise<PluginInstallPreview | null> {
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
      return null;
    }
    const archivePath = path.resolve(result.filePaths[0]);
    await this.ensureRoot();
    await fsp.mkdir(pluginStagingDirectory(), { recursive: true });
    const token = randomUUID();
    const stage = path.join(pluginStagingDirectory(), token);
    if (!isContained(stage, pluginStagingDirectory())) {
      throw new PluginManagerError("containment", "插件临时目录非法");
    }
    try {
      await extractArchive(archivePath, stage);
      const preview = await this.inspectStagedPlugin(archivePath, stage);
      this.inspections.set(preview.token, {
        archivePath,
        preview,
        stagePath: stage,
      });
      return preview;
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
      if (!this.inspections.has(token) && fs.existsSync(stage)) {
        await fsp.rm(stage, { recursive: true, force: true });
      }
    }
  }

  async discardInspection(token: string): Promise<void> {
    if (!z.string().min(1).max(160).safeParse(token).success) {
      throw new PluginManagerError("invalid-input", "插件检查令牌无效");
    }
    const inspection = this.inspections.get(token);
    if (!inspection) {
      return;
    }
    this.inspections.delete(token);
    if (
      isContained(inspection.stagePath, pluginStagingDirectory()) &&
      path.dirname(inspection.stagePath) === pluginStagingDirectory()
    ) {
      await fsp.rm(inspection.stagePath, { recursive: true, force: true });
    }
  }

  private async pruneOldInstallations(pluginId: string): Promise<void> {
    const entries = (await this.installedManifests())
      .filter(
        (entry) =>
          entry.manifest.id === pluginId &&
          entry.origin !== "dev" &&
          entry.directory
      )
      .sort((left, right) =>
        compareVersions(right.manifest.version, left.manifest.version)
      );
    const preference = this.tryStore(
      (store) => store.getPreference(pluginId),
      null
    );
    const protectedVersions = new Set(
      [preference?.selectedVersion, preference?.lastKnownGoodVersion].filter(
        (version): version is string => Boolean(version)
      )
    );
    const keep = new Set(
      entries
        .slice(0, 2)
        .map((entry) => entry.manifest.version)
        .concat([...protectedVersions])
    );
    for (const entry of entries) {
      if (keep.has(entry.manifest.version)) {
        continue;
      }
      if (
        entry.directory &&
        isContained(entry.directory, pluginDirectory()) &&
        path.dirname(entry.directory) === path.join(pluginDirectory(), pluginId)
      ) {
        this.tryStore(
          (store) => store.deleteInstallation(pluginId, entry.manifest.version),
          false
        );
        await fsp.rm(entry.directory, { recursive: true, force: true });
      }
    }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: installation commit repeats security checks before changing persistent state.
  async commitInstall(token: string): Promise<AnyPluginSnapshot> {
    const inspection = this.inspections.get(token);
    if (!inspection) {
      throw new PluginManagerError(
        "inspection-not-found",
        "插件检查结果已失效"
      );
    }
    const { manifest } = inspection.preview;
    const target = path.join(pluginDirectory(), manifest.id, manifest.version);
    if (
      !isContained(target, pluginDirectory()) ||
      path.dirname(target) !== path.join(pluginDirectory(), manifest.id)
    ) {
      throw new PluginManagerError("containment", "插件安装路径非法");
    }
    if (fs.existsSync(target)) {
      await this.discardInspection(token);
      throw new PluginManagerError("same-version", "相同版本插件已安装");
    }
    const current = (await this.installedManifests()).filter(
      (entry) => entry.manifest.id === manifest.id
    );
    const persisted = this.tryStore(
      (store) => store.listInstallations(manifest.id),
      []
    );
    if (
      current.some((entry) => entry.manifest.version === manifest.version) ||
      persisted.some((entry) => entry.version === manifest.version)
    ) {
      await this.discardInspection(token);
      throw new PluginManagerError("same-version", "相同版本插件已安装");
    }
    const highest = [...current].sort((left, right) =>
      compareVersions(right.manifest.version, left.manifest.version)
    )[0];
    const persistedHighest = [...persisted].sort((left, right) =>
      compareVersions(right.version, left.version)
    )[0];
    const highestVersion =
      highest?.manifest.version ?? persistedHighest?.version;
    if (
      highestVersion &&
      compareVersions(manifest.version, highestVersion) < 0
    ) {
      throw new PluginManagerError("downgrade", "正式插件包不允许降级");
    }
    // The staging directory is user-writable between preflight and confirm;
    // repeat every security check before making it an installed package.
    try {
      const stagedManifest = readInstalledManifest(inspection.stagePath);
      if (
        stagedManifest.id !== manifest.id ||
        stagedManifest.version !== manifest.version
      ) {
        throw new PluginManagerError(
          "invalid-package",
          "预检插件内容已发生变化"
        );
      }
      await validatePackageLayout(inspection.stagePath, stagedManifest, false);
      await validateManifestResources(inspection.stagePath, stagedManifest);
      if (stagedManifest.manifestVersion === 3) {
        await verifyLocaleSignature(
          inspection.stagePath,
          this.trustedKeys,
          false
        );
      }
    } catch (error) {
      await this.discardInspection(token);
      throw error instanceof PluginManagerError
        ? error
        : new PluginManagerError("invalid-package", sanitizePluginError(error));
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    try {
      await fsp.rename(inspection.stagePath, target);
      const store = this.requiredStore();
      const existingPreference = store.getPreference(manifest.id);
      const existingSettings =
        existingPreference?.settings &&
        typeof existingPreference.settings === "object" &&
        !Array.isArray(existingPreference.settings)
          ? (existingPreference.settings as Record<string, unknown>)
          : {};
      const settings = validateAnyPluginSettings(manifest, existingSettings);
      store.commitInstall({
        installation: {
          checksum: `sha256:${inspection.preview.checksum}`,
          manifest: manifest as unknown as JsonValue,
          origin: "local",
          pluginId: manifest.id,
          relativeLocation: path
            .relative(app.getPath("userData"), target)
            .replaceAll(path.sep, "/"),
          status: "installed",
          version: manifest.version,
        },
        preference: existingPreference
          ? {
              lastKnownGoodVersion: existingPreference.lastKnownGoodVersion,
              pluginId: manifest.id,
              selectedVersion: manifest.version,
              settings: settings as unknown as JsonValue,
              settingsSchemaVersion: existingPreference.settingsSchemaVersion,
            }
          : {
              lastKnownGoodVersion: null,
              pluginId: manifest.id,
              selectedVersion: manifest.version,
              settings: settings as unknown as JsonValue,
              settingsSchemaVersion: 1,
            },
      });
    } catch (error) {
      if (fs.existsSync(target) && isContained(target, pluginDirectory())) {
        await fsp.rm(target, { recursive: true, force: true });
      }
      await this.discardInspection(token);
      if (error instanceof PluginManagerError) {
        throw error;
      }
      throw new PluginManagerError("database", sanitizePluginError(error));
    }
    this.inspections.delete(token);
    try {
      await this.pruneOldInstallations(manifest.id);
    } catch (error) {
      log.warn(
        { error: sanitizePluginError(error), pluginId: manifest.id },
        "old plugin version cleanup deferred"
      );
    }
    return this.list();
  }

  async installFromDialog(): Promise<AnyPluginSnapshot> {
    const preview = await this.inspectFromDialog();
    if (!preview) {
      return this.list();
    }
    return this.commitInstall(preview.token);
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: enabling coordinates legacy flags and the v2 active-id store.
  async setEnabled(
    pluginId: string,
    enabled: boolean
  ): Promise<AnyPluginSnapshot> {
    const snapshot = await this.list();
    const target = snapshot.plugins.find(
      (plugin) => plugin.manifest.id === pluginId
    );
    if (!target) {
      throw new PluginManagerError("plugin-not-found", "插件不存在");
    }
    if (target.manifest.manifestVersion === 3) {
      throw new PluginManagerError("invalid-input", "语言包请通过语言设置启用");
    }
    if (target.status === "incompatible" || target.status === "invalid") {
      throw new PluginManagerError(
        "plugin-incompatible",
        "插件与当前应用不兼容"
      );
    }
    const store = this.optionalStore();
    if (enabled) {
      if (store) {
        store.setActivePluginId(pluginId);
      } else {
        for (const plugin of snapshot.plugins) {
          if (plugin.manifest.capabilities[0] === "theme") {
            setSetting(
              pluginEnabledKey(plugin.manifest.id),
              plugin.manifest.id === pluginId ? "true" : "false"
            );
          }
        }
      }
    } else if (!store) {
      setSetting(pluginEnabledKey(pluginId), "false");
    } else if (store.getActivePluginId() === pluginId) {
      store.clearActivePluginId();
    }
    return this.list();
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: activation rollback updates installation, preference and active-id state.
  reportActivationResult(
    pluginId: string,
    version: string,
    success: boolean,
    errorCode?: string,
    errorDetail?: string
  ): Promise<AnyPluginSnapshot> {
    if (
      !(
        z.string().min(1).max(160).safeParse(pluginId).success &&
        isValidSemVer(version)
      ) ||
      typeof success !== "boolean"
    ) {
      throw new PluginManagerError("invalid-input", "插件激活结果参数无效");
    }
    const store = this.requiredStore();
    const installation = store.getInstallation(pluginId, version);
    if (!installation) {
      throw new PluginManagerError("plugin-not-found", "插件安装不存在");
    }
    const preference = store.getPreference(pluginId);
    const activePluginId = store.getActivePluginId();
    const installationUpdate = {
      checksum: installation.checksum,
      installedAt: installation.installedAt,
      manifest: installation.manifest,
      origin: installation.origin,
      pluginId,
      relativeLocation: installation.relativeLocation,
      sourceLocation: installation.sourceLocation,
      version,
    };
    if (success) {
      store.commitInstall({
        installation: {
          ...installationUpdate,
          lastErrorCode: null,
          lastErrorDetail: null,
          status: "installed",
        },
        preference: {
          lastKnownGoodVersion: version,
          pluginId,
          selectedVersion: version,
          settings: preference?.settings ?? {},
          settingsSchemaVersion: preference?.settingsSchemaVersion ?? 1,
        },
      });
    } else {
      const fallbackVersion = preference?.lastKnownGoodVersion;
      const fallbackInstallation = fallbackVersion
        ? store.getInstallation(pluginId, fallbackVersion)
        : null;
      store.commitInstall({
        ...(activePluginId === pluginId
          ? { activePluginId: fallbackInstallation ? pluginId : null }
          : {}),
        installation: {
          ...installationUpdate,
          lastErrorCode: errorCode || "activation-failed",
          lastErrorDetail: errorDetail,
          status: "failed",
        },
        ...(preference
          ? {
              preference: {
                lastKnownGoodVersion: fallbackInstallation
                  ? fallbackVersion
                  : null,
                pluginId,
                selectedVersion: fallbackInstallation ? fallbackVersion : null,
                settings: preference.settings,
                settingsSchemaVersion: preference.settingsSchemaVersion,
              },
            }
          : {}),
      });
    }
    return this.list();
  }

  async setSettings(
    pluginId: string,
    settings: Record<string, unknown>
  ): Promise<AnyPluginSnapshot> {
    const snapshot = await this.list();
    const target = snapshot.plugins.find(
      (plugin) => plugin.manifest.id === pluginId
    );
    if (!target) {
      throw new PluginManagerError("plugin-not-found", "插件不存在");
    }
    if (target.manifest.manifestVersion === 3) {
      throw new PluginManagerError("invalid-input", "语言包不支持插件设置");
    }
    const merged = validateAnyPluginSettings(target.manifest, {
      ...target.settings,
      ...settings,
    });
    const store = this.optionalStore();
    if (store) {
      const previous = store.getPreference(pluginId);
      store.upsertPreference({
        lastKnownGoodVersion:
          previous?.lastKnownGoodVersion ?? target.manifest.version,
        pluginId,
        selectedVersion: previous?.selectedVersion ?? target.manifest.version,
        settings: merged as unknown as JsonValue,
        settingsSchemaVersion: previous?.settingsSchemaVersion ?? 1,
      });
    } else {
      setSetting(pluginSettingsKey(pluginId), JSON.stringify(merged));
    }
    return this.list();
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: asset selection validates dialog, MIME, managed copy and legacy fallback.
  async selectAsset(
    pluginId: string,
    settingId: string
  ): Promise<AnyPluginSnapshot> {
    const snapshot = await this.list();
    const target = snapshot.plugins.find(
      (plugin) => plugin.manifest.id === pluginId
    );
    const definition = target && settingFor(target.manifest, settingId);
    if (
      !(target && definition) ||
      (definition.type !== "image" && definition.type !== "video")
    ) {
      throw new PluginManagerError("plugin-not-found", "插件资源设置不存在");
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
        throw new PluginManagerError(
          "invalid-input",
          "插件资源类型与设置不匹配"
        );
      }
      const revision = randomUUID();
      const store = this.optionalStore();
      if (store) {
        const previousAsset = store.getAsset(pluginId, settingId);
        const previousPreference = store.getPreference(pluginId);
        const managedDirectory = pluginDataDirectory(pluginId, settingId);
        await fsp.mkdir(managedDirectory, { recursive: true });
        const extension = path.extname(selected).toLowerCase();
        const managedPath = path.join(
          managedDirectory,
          `${revision}${extension}`
        );
        if (!isContained(managedPath, pluginDataDirectory(pluginId))) {
          throw new PluginManagerError("containment", "插件资源路径非法");
        }
        try {
          await fsp.copyFile(selected, managedPath);
          const stat = await fsp.stat(managedPath);
          store.upsertAsset({
            byteSize: stat.size,
            managedPath,
            mimeType: mimeTypes[extension] ?? "application/octet-stream",
            pluginId,
            revision,
            settingId,
          });
          const preferenceSettings =
            previousPreference?.settings &&
            typeof previousPreference.settings === "object" &&
            !Array.isArray(previousPreference.settings)
              ? { ...previousPreference.settings }
              : { ...target.settings };
          preferenceSettings[settingId] = revision;
          store.upsertPreference({
            lastKnownGoodVersion:
              previousPreference?.lastKnownGoodVersion ??
              target.manifest.version,
            pluginId,
            selectedVersion:
              previousPreference?.selectedVersion ?? target.manifest.version,
            settings: preferenceSettings as unknown as JsonValue,
            settingsSchemaVersion:
              previousPreference?.settingsSchemaVersion ?? 1,
          });
        } catch (error) {
          try {
            if (previousAsset) {
              store.upsertAsset(previousAsset);
            } else {
              store.deleteAsset(pluginId, settingId);
            }
          } catch (rollbackError) {
            log.warn(
              {
                error: sanitizePluginError(rollbackError),
                pluginId,
                settingId,
              },
              "plugin asset record rollback failed"
            );
          }
          if (
            fs.existsSync(managedPath) &&
            isContained(managedPath, pluginDataDirectory(pluginId))
          ) {
            await fsp.rm(managedPath, { force: true });
          }
          throw new PluginManagerError("database", sanitizePluginError(error));
        }
        if (previousAsset?.managedPath !== managedPath) {
          let previousManagedPath: string | null = null;
          if (previousAsset?.managedPath) {
            previousManagedPath = path.isAbsolute(previousAsset.managedPath)
              ? previousAsset.managedPath
              : path.resolve(
                  app.getPath("userData"),
                  previousAsset.managedPath
                );
          }
          if (
            previousManagedPath &&
            isContained(previousManagedPath, pluginDataDirectory(pluginId))
          ) {
            try {
              await fsp.rm(previousManagedPath, { force: true });
            } catch (cleanupError) {
              log.warn(
                {
                  error: sanitizePluginError(cleanupError),
                  pluginId,
                  settingId,
                },
                "stale plugin asset cleanup failed"
              );
            }
          }
        }
      } else {
        // Legacy fallback is retained for installations whose DB has not yet
        // been migrated; the v2 store path above never persists source paths.
        setSetting(pluginAssetKey(pluginId, settingId), selected);
        setSetting(pluginAssetRevisionKey(pluginId, settingId), revision);
      }
    }
    return this.list();
  }

  async removeAsset(
    pluginId: string,
    settingId: string
  ): Promise<AnyPluginSnapshot> {
    const parsed = validatePluginAssetInput({ pluginId, settingId });
    const snapshot = await this.list();
    const target = snapshot.plugins.find(
      (plugin) => plugin.manifest.id === parsed.pluginId
    );
    const definition = target
      ? settingFor(target.manifest, parsed.settingId)
      : undefined;
    if (
      !(target && definition) ||
      (definition.type !== "image" && definition.type !== "video")
    ) {
      throw new PluginManagerError("plugin-not-found", "插件资源设置不存在");
    }
    const resetValue = definition?.defaultValue ?? null;
    const store = this.optionalStore();
    if (store) {
      const previousPreference = store.getPreference(parsed.pluginId);
      const preferenceSettings =
        previousPreference?.settings &&
        typeof previousPreference.settings === "object" &&
        !Array.isArray(previousPreference.settings)
          ? { ...previousPreference.settings }
          : { ...target.settings };
      preferenceSettings[parsed.settingId] = resetValue;
      const reset = store.upsertPreferenceAndDeleteAssets(
        {
          lastKnownGoodVersion: previousPreference?.lastKnownGoodVersion,
          pluginId: parsed.pluginId,
          selectedVersion:
            previousPreference?.selectedVersion ?? target.manifest.version,
          settings: preferenceSettings as unknown as JsonValue,
          settingsSchemaVersion: previousPreference?.settingsSchemaVersion ?? 1,
        },
        [parsed.settingId]
      );
      await this.cleanupManagedAssets(parsed.pluginId, reset.assets);
    } else {
      deleteSetting(pluginAssetKey(parsed.pluginId, parsed.settingId));
      deleteSetting(pluginAssetRevisionKey(parsed.pluginId, parsed.settingId));
      const rawSettings = getSetting(pluginSettingsKey(parsed.pluginId));
      if (rawSettings) {
        try {
          const legacySettings = JSON.parse(rawSettings) as Record<
            string,
            unknown
          >;
          legacySettings[parsed.settingId] = resetValue;
          setSetting(
            pluginSettingsKey(parsed.pluginId),
            JSON.stringify(legacySettings)
          );
        } catch {
          // Keep a malformed legacy setting isolated; the next list normalizes it.
        }
      }
    }
    return this.list();
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: reset supports validated whole-plugin and selected-setting paths.
  async resetSettings(
    pluginId: string,
    settingIds?: string[]
  ): Promise<AnyPluginSnapshot> {
    if (!z.string().min(1).max(160).safeParse(pluginId).success) {
      throw new PluginManagerError("invalid-input", "插件 ID 无效");
    }
    if (
      settingIds !== undefined &&
      (!Array.isArray(settingIds) ||
        settingIds.length > 256 ||
        settingIds.some(
          (settingId) =>
            typeof settingId !== "string" ||
            !z.string().min(1).max(160).safeParse(settingId).success
        ))
    ) {
      throw new PluginManagerError("invalid-input", "插件设置 ID 无效");
    }
    const requested = [...new Set(settingIds ?? [])];
    const snapshot = await this.list();
    const target = snapshot.plugins.find(
      (plugin) => plugin.manifest.id === pluginId
    );
    if (!target) {
      throw new PluginManagerError("plugin-not-found", "插件不存在");
    }
    if (target.manifest.manifestVersion === 3) {
      throw new PluginManagerError("invalid-input", "语言包不支持插件设置");
    }
    if (requested.length > 0) {
      const definitions = new Map(
        target.manifest.settings.map((setting) => [setting.id, setting])
      );
      if (requested.some((settingId) => !definitions.has(settingId))) {
        throw new PluginManagerError("invalid-input", "插件设置不存在");
      }
      const nextSettings = { ...target.settings } as Record<string, unknown>;
      for (const settingId of requested) {
        const definition = definitions.get(settingId);
        if (definition) {
          nextSettings[settingId] = definition.defaultValue;
        }
      }
      const normalized = validateAnyPluginSettings(
        target.manifest,
        nextSettings
      );
      const assetSettingIds = requested.filter((settingId) => {
        const definition = definitions.get(settingId);
        return definition?.type === "image" || definition?.type === "video";
      });
      const store = this.optionalStore();
      if (store) {
        const previous = store.getPreference(pluginId);
        const reset = store.upsertPreferenceAndDeleteAssets(
          {
            lastKnownGoodVersion: previous?.lastKnownGoodVersion,
            pluginId,
            selectedVersion:
              previous?.selectedVersion ?? target.manifest.version,
            settings: normalized as unknown as JsonValue,
            settingsSchemaVersion: previous?.settingsSchemaVersion ?? 1,
          },
          assetSettingIds
        );
        await this.cleanupManagedAssets(pluginId, reset.assets);
      } else {
        setSetting(pluginSettingsKey(pluginId), JSON.stringify(normalized));
        for (const settingId of assetSettingIds) {
          deleteSetting(pluginAssetKey(pluginId, settingId));
          deleteSetting(pluginAssetRevisionKey(pluginId, settingId));
        }
      }
      return this.list();
    }
    const store = this.optionalStore();
    if (store) {
      const previous = store.getPreference(pluginId);
      const defaults = validateAnyPluginSettings(target.manifest, {});
      const assetSettingIds = target.manifest.settings
        .filter(
          (setting) => setting.type === "image" || setting.type === "video"
        )
        .map((setting) => setting.id);
      const reset = store.upsertPreferenceAndDeleteAssets(
        {
          lastKnownGoodVersion: previous?.lastKnownGoodVersion,
          pluginId,
          selectedVersion: previous?.selectedVersion ?? target.manifest.version,
          settings: defaults as unknown as JsonValue,
          settingsSchemaVersion: previous?.settingsSchemaVersion ?? 1,
        },
        assetSettingIds
      );
      await this.cleanupManagedAssets(pluginId, reset.assets);
      deleteSettingsByPrefix(`plugins.${pluginId}.`);
    } else {
      deleteSetting(pluginSettingsKey(pluginId));
      deleteSetting(pluginRecipeVersionKey(pluginId));
      for (const setting of target.manifest.settings) {
        if (setting.type === "image" || setting.type === "video") {
          deleteSetting(pluginAssetKey(pluginId, setting.id));
          deleteSetting(pluginAssetRevisionKey(pluginId, setting.id));
        }
      }
    }
    return this.list();
  }

  setDeveloperMode(enabled: boolean): Promise<AnyPluginSnapshot> {
    if (typeof enabled !== "boolean") {
      throw new PluginManagerError("invalid-input", "开发者模式参数无效");
    }
    this.developerMode = enabled;
    return this.list();
  }

  async loadDevDirectoryFromDialog(): Promise<AnyPluginSnapshot> {
    if (!this.developerMode) {
      throw new PluginManagerError(
        "developer-mode-required",
        "请先启用开发者模式"
      );
    }
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: getLocalizedText(
        { en: "Load developer plugin", zh: "加载开发插件" },
        app.getLocale()
      ),
    });
    if (result.canceled || !result.filePaths[0]) {
      return this.list();
    }
    const directory = path.resolve(result.filePaths[0]);
    let manifest: NormalizedPluginManifest;
    try {
      manifest = readInstalledManifest(directory);
      await validatePackageLayout(directory, manifest, true);
      await validateManifestResources(directory, manifest);
    } catch (error) {
      throw new PluginManagerError(
        "invalid-manifest",
        sanitizePluginError(error)
      );
    }
    if (manifest.manifestVersion !== 2 && manifest.manifestVersion !== 3) {
      throw new PluginManagerError(
        "invalid-manifest",
        "开发插件必须使用 v2 主题或 v3 语言声明式清单"
      );
    }
    if (manifest.manifestVersion === 3) {
      await verifyLocaleSignature(directory, this.trustedKeys, true);
    }
    if (this.builtins.some((builtin) => builtin.id === manifest.id)) {
      throw new PluginManagerError(
        "builtin-conflict",
        "插件 ID 与内置插件冲突"
      );
    }
    const entry: InstalledManifestEntry = {
      directory,
      manifest,
      origin: "dev",
    };
    this.devPlugins.set(manifest.id, entry);
    const store = this.optionalStore();
    if (store) {
      for (const oldInstallation of store
        .listInstallations(manifest.id)
        .filter((installation) => installation.origin === "dev")) {
        if (oldInstallation.version !== manifest.version) {
          store.deleteInstallation(manifest.id, oldInstallation.version);
        }
      }
      store.upsertInstallation({
        manifest: manifest as unknown as JsonValue,
        origin: "dev",
        pluginId: manifest.id,
        sourceLocation: directory,
        status: "installed",
        version: manifest.version,
      });
    }
    return this.list();
  }

  async reloadDevPlugin(pluginId: string): Promise<AnyPluginSnapshot> {
    const entry = this.devPlugins.get(pluginId);
    if (!entry?.directory) {
      throw new PluginManagerError(
        "developer-plugin-not-found",
        "开发插件不存在"
      );
    }
    const manifest = readInstalledManifest(entry.directory);
    await validatePackageLayout(entry.directory, manifest, true);
    await validateManifestResources(entry.directory, manifest);
    if (manifest.manifestVersion !== 2 && manifest.manifestVersion !== 3) {
      throw new PluginManagerError(
        "invalid-manifest",
        "开发插件必须使用 v2 主题或 v3 语言声明式清单"
      );
    }
    if (manifest.manifestVersion === 3) {
      await verifyLocaleSignature(entry.directory, this.trustedKeys, true);
    }
    if (
      manifest.id !== pluginId ||
      this.builtins.some((builtin) => builtin.id === manifest.id)
    ) {
      throw new PluginManagerError("invalid-manifest", "开发插件 ID 无效");
    }
    this.devPlugins.set(pluginId, {
      ...entry,
      manifest,
    });
    const store = this.optionalStore();
    if (store) {
      if (entry.manifest.version !== manifest.version) {
        store.deleteInstallation(pluginId, entry.manifest.version);
      }
      store.upsertInstallation({
        manifest: manifest as unknown as JsonValue,
        origin: "dev",
        pluginId: manifest.id,
        sourceLocation: entry.directory,
        status: "installed",
        version: manifest.version,
      });
    }
    return this.list();
  }

  removeDevPlugin(pluginId: string): Promise<AnyPluginSnapshot> {
    const entry = this.devPlugins.get(pluginId);
    if (entry) {
      this.devPlugins.delete(pluginId);
      const store = this.optionalStore();
      if (store) {
        for (const installation of store
          .listInstallations(pluginId)
          .filter((row) => row.origin === "dev")) {
          store.deleteInstallation(pluginId, installation.version);
        }
      }
    }
    return this.list();
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: uninstall coordinates filesystem and optional retained data atomically.
  async uninstall(
    pluginId: string,
    removeData = true
  ): Promise<AnyPluginSnapshot> {
    const snapshot = await this.list();
    const target = snapshot.plugins.find(
      (plugin) => plugin.manifest.id === pluginId
    );
    if (!target) {
      throw new PluginManagerError("plugin-not-found", "插件不存在");
    }
    if (target.source === "builtin") {
      throw new PluginManagerError("invalid-input", "内置插件不能卸载");
    }
    if (target.source === "dev") {
      throw new PluginManagerError(
        "invalid-input",
        "开发目录插件请使用移除开发插件"
      );
    }
    const installed = (await this.installedManifests()).filter(
      (item) => item.manifest.id === pluginId
    );
    const store = this.optionalStore();
    const assets = store ? store.listAssets(pluginId) : [];
    const quarantine = path.join(
      pluginStagingDirectory(),
      `uninstall-${randomUUID()}`
    );
    if (!isContained(quarantine, pluginStagingDirectory())) {
      throw new PluginManagerError("containment", "插件卸载隔离路径非法");
    }
    const moved: Array<{ original: string; quarantined: string }> = [];
    try {
      await fsp.mkdir(quarantine, { recursive: true });
      for (const item of installed) {
        const isDev =
          item.origin === "dev" || item.installation?.origin === "dev";
        if (
          isDev ||
          !item.directory ||
          !isContained(item.directory, pluginDirectory()) ||
          path.dirname(item.directory) !==
            path.join(pluginDirectory(), pluginId)
        ) {
          continue;
        }
        const quarantined = path.join(
          quarantine,
          path.basename(item.directory)
        );
        if (!isContained(quarantined, quarantine)) {
          throw new PluginManagerError("containment", "插件卸载版本路径非法");
        }
        await fsp.rename(item.directory, quarantined);
        moved.push({ original: item.directory, quarantined });
      }
      if (store) {
        store.uninstall({ pluginId, removeData });
      } else {
        setSetting(pluginEnabledKey(pluginId), "false");
        if (removeData) {
          deleteSettingsByPrefix(`plugins.${pluginId}.`);
        }
      }
    } catch (error) {
      for (const item of [...moved].reverse()) {
        try {
          await fsp.mkdir(path.dirname(item.original), { recursive: true });
          if (
            fs.existsSync(item.quarantined) &&
            !fs.existsSync(item.original)
          ) {
            await fsp.rename(item.quarantined, item.original);
          }
        } catch (rollbackError) {
          log.error(
            {
              error: sanitizePluginError(rollbackError),
              pluginId,
            },
            "plugin uninstall filesystem rollback failed"
          );
        }
      }
      if (fs.existsSync(quarantine)) {
        try {
          await fsp.rm(quarantine, { force: true, recursive: true });
        } catch (cleanupError) {
          log.debug(
            { error: sanitizePluginError(cleanupError), pluginId },
            "plugin uninstall rollback cleanup deferred"
          );
        }
      }
      throw error instanceof PluginManagerError
        ? error
        : new PluginManagerError("database", sanitizePluginError(error));
    }
    try {
      await fsp.rm(quarantine, { force: true, recursive: true });
      await fsp.rmdir(path.join(pluginDirectory(), pluginId));
    } catch (error) {
      log.debug(
        { error: sanitizePluginError(error), pluginId },
        "plugin uninstall directory cleanup deferred"
      );
    }
    if (store && removeData) {
      await this.cleanupManagedAssets(pluginId, assets);
    }
    return this.list();
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: resource resolution performs layered URL, containment and MIME checks.
  async resolveResource(
    requestUrl: string,
    rangeHeader?: string | null
  ): Promise<Response> {
    let pluginId: string;
    let version: string | undefined;
    let relative: string;
    try {
      const url = new URL(requestUrl);
      pluginId = decodeURIComponent(url.hostname);
      const segments = url.pathname
        .replace(LEADING_SLASH_PATTERN, "")
        .split("/")
        .filter(Boolean)
        .map((segment) => decodeURIComponent(segment));
      if (segments.length >= 2 && isValidSemVer(segments[0] ?? "")) {
        version = segments.shift();
      }
      relative = segments.join("/");
    } catch {
      return new Response(null, { status: 400 });
    }
    if (!isSafeRelativePath(relative)) {
      return new Response(null, { status: 400 });
    }
    if (!relative.startsWith("assets/")) {
      return new Response(null, { status: 403 });
    }
    const installedEntries = [
      ...(await this.installedManifests()),
      ...(this.developerMode ? [...this.devPlugins.values()] : []),
    ].filter((item) => item.manifest.id === pluginId);
    let installed = version
      ? installedEntries.find((item) => item.manifest.version === version)
      : installedEntries.sort((left, right) =>
          compareVersions(right.manifest.version, left.manifest.version)
        )[0];
    if (version && !installed) {
      const row = this.tryStore(
        (store) => store.getInstallation(pluginId, version as string),
        null
      );
      if (row) {
        let location: string | null = null;
        if (row.sourceLocation) {
          location = path.resolve(row.sourceLocation);
        } else if (row.relativeLocation) {
          location = path.resolve(
            app.getPath("userData"),
            row.relativeLocation
          );
        }
        const devEntry = this.devPlugins.get(pluginId);
        const devLocationAllowed =
          row.origin === "dev" &&
          this.developerMode &&
          devEntry?.directory &&
          devEntry.manifest.version === version &&
          location === path.resolve(devEntry.directory);
        const locationAllowed =
          location &&
          (row.origin === "dev"
            ? devLocationAllowed
            : isContained(location, pluginDirectory()));
        if (locationAllowed && location) {
          try {
            installed = {
              directory: location,
              installation: row,
              manifest: readInstalledManifest(location),
              origin: row.origin === "dev" ? "dev" : "local",
            };
          } catch {
            installed = undefined;
          }
        }
      }
    }
    if (!installed) {
      return new Response(null, { status: 404 });
    }
    if (!installed.directory) {
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
    const store = this.optionalStore();
    const storedAsset = store ? store.getAsset(pluginId, settingId) : null;
    const storedPath = store
      ? storedAsset?.managedPath
      : getSetting(pluginAssetKey(pluginId, settingId));
    let filePath: string | null = null;
    if (storedPath) {
      filePath = path.isAbsolute(storedPath)
        ? storedPath
        : path.resolve(app.getPath("userData"), storedPath);
    }
    if (!(filePath && path.isAbsolute(filePath) && fs.existsSync(filePath))) {
      return new Response(null, { status: 404 });
    }
    if (storedAsset && !isContained(filePath, pluginDataDirectory(pluginId))) {
      return new Response(null, { status: 403 });
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
  builtins: NormalizedPluginManifest[],
  trustedKeys: PluginTrustedKeyring = PLUGIN_TRUSTED_KEYS
): PluginManager {
  manager ??= new PluginManager(builtins, undefined, trustedKeys);
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
